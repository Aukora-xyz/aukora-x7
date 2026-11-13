/** Owner-only cloud brokers. Variable web targets require a separate public-only transport; mirror data never becomes publication input. */
import { canonicalJson } from './owner-grant-policy.mjs'
import { EDGE_DIAGNOSTIC_LIMITS, projectDiagnostics } from './edge-diagnostics.mjs'
import { validStateDiffBase, validMirrorIdentity, projectHeadStateDiff } from './state-diff.mjs'
import { isDeployInertRepoPath } from '../../ci/deploy-paths.mjs'
import { PROPOSAL_PATH_NEXTS, caseTwinPaths, isPlainRepoPath, proposalPathRefusal } from '../../ci/frozen-paths.mjs'
import { headProblem, mirrorCopyRefusals, referencedModules, serializeHead, sha256Hex } from '../../ci/mirror-copy.mjs'

const REPOSITORY = 'your_org_x/your-node'
const BRANCH = 'main'
const SHA = /^[0-9a-f]{40}$/
const AUMA_BRANCH_RE = /^auma\/(?:sandbox|proposal)\/[a-z0-9][a-z0-9._-]{1,60}$/
const ZERO_SHA = '0'.repeat(40)
const sourceFile = path => sourceFiles.has(path) || /^tsconfig(?:\.[A-Za-z0-9_-]+)*\.json$/.test(path)
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
const fail = (code, status = 400, details = {}) => { throw Object.assign(new Error(code), { code, status, ...details }) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const size = value => encoder.encode(value).length
const freezeJson = value => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}
const privatePart = part => (part.startsWith('.') && part !== '.github') || /(?:private|secret|credential|password|keypair|identity|vault|token)/i.test(part) || /(?:^|[._-])keys?(?:[._-]|$)/i.test(part) || /^(?:id_rsa|id_ed25519|node_modules|dist|generated|backups?)$/i.test(part)
const sourceOrgan = path => /^mirror\/home\/(?:auma(?:\/(?:HEAD\.json|HANDOFF\.md|seed(?:\/(?:organs|candidates|staging)(?:\/[a-z0-9-]+\.js)?)?))?|organs(?:\/[a-z0-9-]+\.js)?|balls(?:\/[A-Za-z0-9.-]+)?)$/.test(path)
const documentPath = path => /^docs\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/.test(path) || /^NORTH-STAR[A-Za-z0-9_.-]*\.md$/.test(path)
const sourceRoots = new Set(['.github', 'deploy', 'server', 'packages', 'apps', 'scripts', 'mirror', 'docs', 'bench'])
const sourceFiles = new Set(['package.json', 'AGENTS.md', 'NORTH-STAR.md', 'README.md', 'README.zh.md', 'tsconfig.json'])
const stagedOwnerWrites = new Map()
const liveMirrorPath = path => path.startsWith('mirror/home/auma/') || documentPath(path)
const canonicalPath = path => typeof path === 'string' && path.length > 0 && path.length <= 1024
  && !/[\\%?#\u0000-\u0020\u007f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..' && !privatePart(part))

/** Fixed byte/time ceilings apply to complete streams, not only declared Content-Length. */
export const CLOUD_BROKER_LIMITS = Object.freeze({ requestBytes: 256 * 1024, responseBytes: 256 * 1024, fileBytes: 64 * 1024, publicationBytes: 128 * 1024, files: 16, timeoutMs: 10000 })

/** Repository source reads allow 512 KiB decoded, including the core runtime loader. */
export const CLOUD_REPO_READ_LIMITS = Object.freeze({
  fileBytes: 512 * 1024,
  // Base64 with GitHub line breaks and bounded metadata.
  encodedResponseBytes: Math.ceil(512 * 1024 / 3) * 4 + 32 * 1024,
  // JSON escapes plus the GitHub broker's nested stdout copy and bounded metadata.
  responseBytes: 13 * 512 * 1024 + 16 * 1024,
})

/** Private source drafts/commits support core files without enlarging legacy main publication. */
export const CLOUD_REPO_BRANCH_LIMITS = Object.freeze({ fileBytes: 512 * 1024, publicationBytes: 1024 * 1024, requestBytes: 6 * 1024 * 1024 + 32 * 1024 })

/** Exact-byte inspection admits whole safe UTF-8 source files before exposing any slice or digest. */
export const CLOUD_REPO_BYTE_LIMITS = Object.freeze({ sliceBytes: 4096, defaultSliceBytes: 256 })

/** A recursive GitHub tree is one bounded response, never a recursive fetch loop. */
export const CLOUD_REPO_TREE_LIMITS = Object.freeze({ responseBytes: 12 * 1024 * 1024, entries: 50000, returnedEntries: 1000, projectedBytes: 96 * 1024 })

/** Search and proposal inspection never silently convert incomplete evidence to success. */
export const CLOUD_REPO_PROPOSAL_LIMITS = Object.freeze({ files: 100, bytes: 96 * 1024, inspectedBytes: 4 * 1024 * 1024, searchFiles: 128, searchBytes: 4 * 1024 * 1024, searchMatches: 200, logBytes: 2 * 1024 * 1024, logTailBytes: 128 * 1024 })

function repoPathAllowed(path) {
  return canonicalPath(path) && (sourceFile(path) || path.includes('/') && sourceRoots.has(path.split('/')[0]) || liveMirrorPath(path))
}

// Live memory is readable only through the original owner MIRROR subset. It is
// never a remote source fallback or publication input, even with an innocuous name.
const remotePathAllowed = path => canonicalPath(path) && (sourceFile(path) || path.includes('/') && sourceRoots.has(path.split('/')[0]))
  && (!path.startsWith('mirror/home/') || sourceOrgan(path))
  && !path.startsWith('mirror/workspace/')
  && (!path.startsWith('mirror/') || !path.split('/').some(part => /^(?:memory|snapshots?|conflicts?|receipts?|journals?|sessions?|logs?)$/i.test(part)))

/** Validate the exact VFS subset readable by the owner broker; this confers no publication permission.
 * @param {string} path Canonical absolute mirror path.
 * @returns {boolean} Whether the path is an allowed owner-only source or memory read.
 */
export function cloudRepoMirrorPathAllowed(path) {
  if (typeof path !== 'string') return false
  if (path.startsWith('/dsh/home/auma/')) return canonicalPath('mirror/home/auma/' + path.slice('/dsh/home/auma/'.length))
  return path.startsWith('/dsh/workspace/') && documentPath(path.slice('/dsh/workspace/'.length)) && canonicalPath(path.slice('/dsh/workspace/'.length))
}

function requirePath(path, publication = false) {
  if (!repoPathAllowed(path) || (publication && !remotePathAllowed(path))) fail('REPO_PATH_REFUSED', 403)
  return path
}

/** What to do instead when an owner-session commit to main names a deployed path (it would go live with no passkey). */
export const DEPLOYED_PATH_NEXT = 'proposal: branch_create auma/proposal/<name>, commit there, stage_proposal; the owner approves the card with a passkey'

/** A commit to main deploys (deploy-x61.yml). The owner-session sink with no passkey takes only deploy-inert paths
 * (deploy/ci/deploy-paths.mjs); a deployed path goes through the proposal card, one passkey over the exact diff.
 * This is not CLASS3_WEBAUTHN_REQUIRED: a passkey over this same request would be refused here again, so her tool must
 * follow `next`, not stage a Touch ID card. Refused at staging too, so nothing uncommittable is ever held. */
function requireDeployInertForOwnerSession(path) {
  if (!isDeployInertRepoPath(path)) fail('REPO_PROPOSAL_REQUIRED', 403, { protectedPath: path, next: DEPLOYED_PATH_NEXT })
}

/** Workflow files change only from the owner's own machine: her proposals refuse .github/ (inspectedChanges). */
export const WORKFLOW_PATH_NEXT = 'workflow files are not changed through her tools: the owner changes .github/ from his own machine'

/** T2 files a proposal branch cannot carry either: the branch path rule (remotePathAllowed) refuses them,
 * e.g. pnpm-lock.yaml, pnpm-workspace.yaml and tsdown.config.ts, so the only real route today is the owner's machine. */
export const OWNER_MACHINE_PATH_NEXT = 'this file cannot go through a proposal today (her branches refuse it): the owner changes it from his own machine'

/** A T2 path on main is never written by this broker, with or without a passkey on the same request:
 * answer the route that works, not CLASS3_WEBAUTHN_REQUIRED, which would send her into an approval this same check
 * refuses again. The proposal card where a proposal branch can carry the file; the owner's machine where it cannot. */
function refuseT2OnMain(path) {
  if (typeof path !== 'string' || !path || /[\\%?#\u0000-\u0020\u007f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('REPO_PATH_REFUSED', 403)
  const workflow = typeof path === 'string' && (path === '.github' || path.startsWith('.github/'))
  fail('REPO_PROPOSAL_REQUIRED', 403, { tier: 'T2', protectedPath: path, next: workflow ? WORKFLOW_PATH_NEXT : remotePathAllowed(path) ? DEPLOYED_PATH_NEXT : OWNER_MACHINE_PATH_NEXT })
}

/** Protected T2 repository paths that define security gates, keys, custody, or deployment workflows.
 * Even under an authenticated owner session, mutating any T2 path requires exact-action Class 3 WebAuthn.
 */
const T2_PROTECTED_EXACT_PATHS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsdown.config.ts',
  'tsconfig.json',
  'tsconfig.host.json',
  'tsconfig.client.json',
  'server/aura-rules.mjs',
  'server/ball-manifest.mjs',
  'server/ball-transition.mjs',
  'server/build-preview.mjs',
  'server/deploy-cloudflare.mjs',
  'server/verified-facts.mjs',
  'scripts/install-lefthook.mjs',
  'scripts/build.ts',
  'packages/experimental/webworker-runtime/src/x6/ball-loader.ts',
  'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts',
])

/** Classify canonical repository paths; Markdown docs skip filename locks, never content screening.
 * @param {string} path Repository-relative path without encoding or traversal segments.
 * @returns {boolean} Whether the path is malformed or requires exact-action Class 3 WebAuthn.
 */
export function isT2ProtectedRepoPath(path) {
  if (typeof path !== 'string' || !path || /[\\%?#\u0000-\u0020\u007f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) return true
  const p = path
  if (/^docs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/.test(p)) return false
  if (T2_PROTECTED_EXACT_PATHS.has(p) || /^tsconfig(?:\.[A-Za-z0-9_-]+)*\.json$/.test(p)) return true
  if (p.startsWith('deploy/') || p.startsWith('.github/')) return true
  if (p.startsWith('packages/experimental/webworker-runtime/src/x6/cells/')) return true
  if (p.startsWith('apps/web/public/cells/')) return true
  if (/(?:^|\/)(?:keys?|custody|aumlok|passkey|owner-grant)/i.test(p)) return true
  return false
}

function safeText(text, env, maximum = CLOUD_BROKER_LIMITS.fileBytes) {
  if (typeof text !== 'string' || size(text) > maximum || /[\u0000]/.test(text)) fail('BROKER_CONTENT_INVALID', 502)
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|["'](?:seedHex|privateKey(?:Hex|Pkcs8|Jwk)?|secretKey(?:Hex)?|access_token|refresh_token|client_secret)["']\s*:/i.test(text)) fail('BROKER_PRIVATE_CONTENT_REFUSED', 403)
  // Error and content echoes from an upstream must not reveal any configured secret.
  for (const [key, value] of Object.entries(env)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$|(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|SIGNING_KEY|CREDENTIAL)(?:_|$)/.test(key) && typeof value === 'string' && value && text.includes(value)) fail('BROKER_PRIVATE_CONTENT_REFUSED', 403)
  return text
}

async function boundedBytes(source, maximum, signal) {
  const declared = source.headers.get('content-length')
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared)))) fail('BROKER_BODY_INVALID')
  if (declared !== null && Number(declared) > maximum) fail('BROKER_BODY_TOO_LARGE', 413)
  const reader = source.body?.getReader()
  if (!reader) fail('BROKER_BODY_INVALID')
  const chunks = []; let bytes = 0
  let rejectAbort
  const aborted = new Promise((resolve, reject) => { rejectAbort = () => { reject(Object.assign(new Error('BROKER_TIMEOUT'), { code: 'BROKER_TIMEOUT', status: 408 })); void reader.cancel().catch(_error => {}) } })
  signal.addEventListener('abort', rejectAbort, { once: true })
  try {
    if (signal.aborted) rejectAbort()
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      bytes += value.byteLength
      if (bytes > maximum) { void reader.cancel().catch(_error => {}); fail('BROKER_BODY_TOO_LARGE', 413) }
      chunks.push(value)
    }
    if (declared !== null && (!source.headers.has('content-encoding') || source.headers.get('content-encoding') === 'identity') && Number(declared) !== bytes) fail('BROKER_BODY_INVALID')
    const joined = new Uint8Array(bytes); let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
    return joined
  } finally { signal.removeEventListener('abort', rejectAbort); reader.releaseLock() }
}

async function boundedJson(source, maximum, signal, observeBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(source.headers.get('content-type') || '')) fail('BROKER_JSON_REQUIRED', 400)
  const bytes = await boundedBytes(source, maximum, signal)
  observeBytes?.(bytes.length)
  try { return JSON.parse(decoder.decode(bytes)) } catch (_error) { fail('BROKER_BODY_INVALID') }
}

/**
 * Run `operation` with a signal that aborts at the deadline (or when `signal` does). Without `settleMs` the answer is
 * BROKER_TIMEOUT at that moment. With `settleMs`, the operation is told (its signal aborts) and given up to that long to
 * settle its own bookkeeping, and ITS answer is the answer: a merge cut off before sending says in the same call that the
 * approval is spent and nothing changed (nothing runs after the response, there is no waitUntil).
 */
async function withDeadline(signal, operation, { settleMs = 0 } = {}) {
  const controller = new AbortController()
  let timeout, grace, onAbort
  const aborted = new Promise((resolve, reject) => {
    const refuse = () => reject(Object.assign(new Error('BROKER_TIMEOUT'), { code: 'BROKER_TIMEOUT', status: 408 }))
    onAbort = () => { controller.abort(); if (settleMs <= 0) refuse(); else grace ??= setTimeout(refuse, settleMs) }
    timeout = setTimeout(onAbort, CLOUD_BROKER_LIMITS.timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    if (signal?.aborted) { controller.abort(); throw Object.assign(new Error('BROKER_TIMEOUT'), { code: 'BROKER_TIMEOUT', status: 408 }) }
    return await Promise.race([operation(controller.signal), aborted])
  } finally { clearTimeout(timeout); clearTimeout(grace); signal?.removeEventListener('abort', onAbort) }
}

async function upstream(networkFetch, url, init, signal, mutation = false, maximum = CLOUD_BROKER_LIMITS.responseBytes) {
  try {
    return await withDeadline(signal, async limitedSignal => {
      const response = await networkFetch(url, { ...init, redirect: 'error', signal: limitedSignal })
      if (response.redirected || (response.status >= 300 && response.status < 400)) fail('BROKER_REDIRECT_REFUSED', 502)
      if (!response.ok) {
        void response.body?.cancel().catch(_error => {})
        fail(response.status === 404 ? 'BROKER_NOT_FOUND' : response.status === 409 ? 'REPO_HEAD_CONFLICT' : 'BROKER_UPSTREAM_FAILED', response.status === 404 ? 404 : response.status === 409 ? 409 : 502)
      }
      return await boundedJson(response, maximum, limitedSignal)
    })
  } catch (error) {
    // A failed mutation response can follow a committed write. No automatic resend.
    if (mutation) fail('REPO_PUBLICATION_OUTCOME_UNKNOWN', 503, { outcome: 'unknown', retry: 'repeat-the-identical-request-to-reconcile' })
    if (typeof error?.code === 'string') throw error
    fail('BROKER_UPSTREAM_FAILED', 502)
  }
}

function githubHeaders(env) {
  const token = env.GITHUB_TOKEN
  if (typeof token !== 'string' || !token) fail('GITHUB_BROKER_TOKEN_UNCONFIGURED', 503)
  if (token.length > 4096 || /\s/.test(token)) fail('GITHUB_BROKER_TOKEN_INVALID', 503)
  return { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'your-node-cloud-broker', 'content-type': 'application/json' }
}

const github = (env, networkFetch, path, signal, maximum = CLOUD_BROKER_LIMITS.responseBytes) => upstream(networkFetch, `https://api.github.com/repos/${REPOSITORY}${path}`, { method: 'GET', headers: githubHeaders(env) }, signal, false, maximum)
const encodePath = path => path.split('/').map(encodeURIComponent).join('/')

function metadata(env) {
  const build = record(env.BUILD_INFO) ? env.BUILD_INFO : {}
  const buildInfo = {}
  for (const key of ['id', 'tag', 'timestamp']) if (typeof build[key] === 'string' && build[key].length <= 200) buildInfo[key] = safeText(build[key], env, 200)
  return { runtime: 'cloudflare', repository: REPOSITORY, branch: BRANCH, sourceRevision: typeof env.SOURCE_REVISION === 'string' && /^[0-9a-f]{7,40}$/.test(env.SOURCE_REVISION) ? env.SOURCE_REVISION : 'UNVERIFIED', buildInfo, macDependency: false }
}

const configured = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/\s/.test(value)
const statusId = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value)

async function selftest(env, context) {
  if (context.bootstrap?.ready !== true) fail('BOOTSTRAP_REQUIRED', 503)
  const { bootstrap, request, signal, publicHttpsFetch, trustedDocsHttpsFetch } = context
  const read = async (binding, path, project) => {
    if (!env[binding]) return { state: 'unavailable', code: 'CLOUD_BINDING_MISSING' }
    try {
      return await withDeadline(signal, async limitedSignal => {
        const headers = { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': bootstrap.head.seedId }
        const response = await env[binding].get(env[binding].idFromName('node-main-v1')).fetch(new Request(new URL(path, request.url), { headers, signal: limitedSignal }))
        if (!response.ok) { void response.body?.cancel().catch(_error => {}); return { state: 'unavailable', code: 'SELFTEST_STATE_UNAVAILABLE' } }
        const value = await boundedJson(response, 64 * 1024, limitedSignal)
        if (!record(value) || value.ok !== true) fail('SELFTEST_STATE_INVALID', 502)
        return { state: 'available', ...project(value) }
      })
    } catch (error) {
      if (error?.code === 'BROKER_TIMEOUT') throw error
      return { state: error?.code ? 'invalid' : 'unavailable', code: error?.code ? 'SELFTEST_STATE_INVALID' : 'SELFTEST_STATE_UNAVAILABLE' }
    }
  }
  const [head, mirror, aumlok] = await Promise.all([
    read('HEAD', '/_head/status', value => {
      if (bootstrap.head?.phase !== 'complete' || !statusId(bootstrap.head.seedId) || !statusId(value.ballId)
        || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || typeof value.governancePromotion !== 'boolean') fail('SELFTEST_STATE_INVALID', 502)
      return { phase: bootstrap.head.phase, seedId: bootstrap.head.seedId, ballId: value.ballId, epoch: value.epoch, governancePromotion: value.governancePromotion }
    }),
    read('MIRROR', '/_mirror/status?compact=1', value => {
      if (bootstrap.mirror?.phase !== 'ready' || !statusId(value.lineageId) || !Number.isSafeInteger(value.revision) || value.revision < 1) fail('SELFTEST_STATE_INVALID', 502)
      return { phase: bootstrap.mirror.phase, lineageId: value.lineageId, revision: value.revision }
    }),
    read('HEAD', '/_host/aumlok/status', value => {
      if (!['BOUND', 'UNBOUND'].includes(value.phase) || typeof value.bound !== 'boolean' || value.bound !== (value.phase === 'BOUND')
        || typeof value.enrollmentAvailable !== 'boolean' || (value.bound && value.enrollmentAvailable)) fail('SELFTEST_STATE_INVALID', 502)
      // AUMLOK stores one credential with its binding. enrollmentCount is history.
      return { phase: value.phase, enrollmentAvailable: value.enrollmentAvailable, credentialCount: value.bound ? 1 : 0, credentialCountSource: 'single-binding-status' }
    }),
  ])
  let meta, buildInfoState = 'available'
  try { meta = metadata(env) }
  catch (_error) { meta = { runtime: 'cloudflare', sourceRevision: 'UNVERIFIED', buildInfo: {} }; buildInfoState = 'invalid' }
  const providerDoors = Object.fromEntries(['deepseek', 'moonshot', 'moonshot-cn', 'openrouter', 'openai', 'anthropic', 'xai']
    .map(name => [name, configured(env[name.toUpperCase().replace('-', '_') + '_API_KEY'])]))
  const ok = buildInfoState === 'available' && [head, mirror, aumlok].every(item => item.state === 'available')
  const githubConfigured = configured(env.GITHUB_TOKEN)
  const cloudflareConfigured = configured(env.CLOUDFLARE_API_TOKEN)
  const webEyesConfigured = typeof publicHttpsFetch === 'function'
  const trustedDocsConfigured = typeof trustedDocsHttpsFetch === 'function'
  return { ok, ...(!ok ? { code: 'SELFTEST_INCOMPLETE' } : {}), action: 'selftest', runtime: 'cloudflare', buildSha: meta.sourceRevision,
    buildInfo: meta.buildInfo, buildInfoState, head, mirror, aumlok, providerDoors,
    githubReachable: githubConfigured, webEyesReachable: webEyesConfigured || trustedDocsConfigured,
    cloudflareReachable: true, trustedDocsReachable: trustedDocsConfigured, deployPipelineConfigured: githubConfigured,
    repoPathPolicy: {
      roots: [...sourceRoots],
      files: [...sourceFiles],
      denylist: ['.env*', 'owner-key*', 'private/**', 'credentials*', 'mirror/home/auma/memory/**', 'mirror/workspace/**'],
    },
    brokers: { githubConfigured, cloudflareConfigured, webEyesConfigured, trustedDocsConfigured }, macDependency: false }
}

async function mirrorRead(path, env, seedId, signal) {
  if (!repoPathAllowed(path) || !liveMirrorPath(path)) fail('REPO_PATH_REFUSED', 403)
  const vfsPath = path.startsWith('mirror/') ? '/dsh/' + path.slice('mirror/'.length) : '/dsh/workspace/' + path
  if (!env.MIRROR) fail('CLOUD_BINDING_MISSING', 503)
  const value = await withDeadline(signal, async limitedSignal => {
    const response = await env.MIRROR.get(env.MIRROR.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_mirror/repo-read', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId }, body: JSON.stringify({ path: vfsPath }), signal: limitedSignal,
    }))
    const result = await boundedJson(response, CLOUD_REPO_READ_LIMITS.encodedResponseBytes, limitedSignal)
    if (!response.ok || result?.ok !== true) fail('REPO_MIRROR_READ_FAILED', response.status === 413 ? 413 : 503)
    return result
  })
  if (value.path !== vfsPath || !['file', 'dir', 'missing', 'gone'].includes(value.kind) || typeof value.lineageId !== 'string' || !Number.isSafeInteger(value.revision) || value.revision < 1) fail('REPO_MIRROR_READ_INVALID', 503)
  return value
}

async function currentState(env, bootstrap, signal) {
  const read = (name, path) => withDeadline(signal, async limitedSignal => {
    const response = await env[name].get(env[name].idFromName('node-main-v1')).fetch(new Request('https://x61.internal' + path, { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': bootstrap.head.seedId }, signal: limitedSignal }))
    const result = await boundedJson(response, CLOUD_BROKER_LIMITS.responseBytes, limitedSignal)
    if (!response.ok || result?.ok !== true) fail('REPO_STATE_UNAVAILABLE', 503)
    return result
  })
  const [head, mirror] = await Promise.all([read('HEAD', '/_head/lease'), read('MIRROR', '/_mirror/status?compact=1')])
  if (typeof head.ballId !== 'string' || !Number.isSafeInteger(head.epoch) || typeof mirror.lineageId !== 'string' || !Number.isSafeInteger(mirror.revision)) fail('REPO_STATE_INVALID', 503)
  return { head: { ballId: head.ballId, epoch: head.epoch }, mirror: { lineageId: mirror.lineageId, revision: mirror.revision, phase: bootstrap.mirror.phase } }
}

function decodeFile(b64, env) {
  return decodeFileBytes(b64, env).content
}

function decodeFileBytes(b64, env, allowNonText = false) {
  if (typeof b64 !== 'string' || b64.length > Math.ceil(CLOUD_REPO_READ_LIMITS.fileBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) fail('BROKER_CONTENT_INVALID', 502)
  let content, bytes
  try {
    const binary = atob(b64)
    if (binary.length > CLOUD_REPO_READ_LIMITS.fileBytes || btoa(binary) !== b64) fail('BROKER_CONTENT_INVALID', 502)
    bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  } catch (_error) { fail('BROKER_CONTENT_INVALID', 502) }
  try { content = decoder.decode(bytes) }
  catch (_error) {
    if (allowNonText) return { byteLength: bytes.length, nonText: 'non_utf8' }
    fail('BROKER_CONTENT_INVALID', 502)
  }
  if (allowNonText && content.includes('\u0000')) return { byteLength: bytes.length, nonText: 'binary' }
  return { bytes, content: safeText(content, env, CLOUD_REPO_READ_LIMITS.fileBytes) }
}

async function byteInspection(input, env, context) {
  if (Object.keys(input).some(key => !['action', 'path', 'offset', 'length'].includes(key))) fail('BROKER_QUERY_INVALID')
  if (context.bootstrap?.ready !== true) fail('BOOTSTRAP_REQUIRED', 503)
  const path = requirePath(input.path, true), offset = input.offset === undefined ? 0 : input.offset, length = input.length === undefined ? CLOUD_REPO_BYTE_LIMITS.defaultSliceBytes : input.length
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > CLOUD_REPO_READ_LIMITS.fileBytes
    || !Number.isSafeInteger(length) || length < 1 || length > CLOUD_REPO_BYTE_LIMITS.sliceBytes) fail('REPO_BYTE_RANGE_INVALID')
  safeText(path, env, 1024)
  const pinned = await pinnedTree('main', env, context.networkFetch, context.signal)
  const entry = regularFile(pinned.tree, path)
  const isPinnedWasm = /^apps\/web\/public\/cells\/[a-z0-9-]+\.wasm$/.test(path)
  const maxFileBytes = isPinnedWasm ? 1024 * 1024 : CLOUD_REPO_READ_LIMITS.fileBytes
  const maxEncodedBytes = isPinnedWasm ? Math.ceil((1024 * 1024) / 3) * 4 + 64 * 1024 : CLOUD_REPO_READ_LIMITS.encodedResponseBytes
  const value = await github(env, context.networkFetch, '/contents/' + encodePath(path) + '?ref=' + pinned.commitSha, context.signal, maxEncodedBytes)
  if (!record(value) || value.type !== 'file' || value.path !== path || value.encoding !== 'base64' || typeof value.content !== 'string'
    || value.submodule_git_url || value.target || value.sha !== entry.sha) fail('BROKER_CONTENT_INVALID', 502)
  let bytes
  if (isPinnedWasm) {
    const rawB64 = value.content.replace(/\n/g, '')
    const binary = atob(rawB64)
    if (binary.length > maxFileBytes || btoa(binary) !== rawB64) fail('BROKER_CONTENT_INVALID', 502)
    bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  } else {
    // Screen the entire decoded file before any byte, digest or slice can leave the broker.
    // Preserve the BOM for an additional secret check; legacy text reads still omit it.
    const decoded = decodeFileBytes(value.content.replace(/\n/g, ''), env)
    bytes = decoded.bytes
    safeText(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), env, CLOUD_REPO_READ_LIMITS.fileBytes)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded.content)) fail('BROKER_CONTENT_INVALID', 502)
  }
  if (entry.size !== undefined && entry.size !== bytes.length) fail('BROKER_CONTENT_INVALID', 502)
  const prefix = encoder.encode(`blob ${bytes.length}\0`), gitBlob = new Uint8Array(prefix.length + bytes.length)
  gitBlob.set(prefix); gitBlob.set(bytes, prefix.length)
  const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  if (hex(new Uint8Array(await crypto.subtle.digest('SHA-1', gitBlob))) !== entry.sha) fail('REPO_BLOB_HASH_MISMATCH', 502)
  if (offset > bytes.length) fail('REPO_BYTE_RANGE_INVALID')
  const slice = bytes.slice(offset, offset + length)
  return { ok: true, action: 'bytes', source: 'github-main', path, commitSha: pinned.commitSha, blobSha: entry.sha,
    totalBytes: bytes.length, offset, length: slice.length, requestedLength: length, truncated: offset + slice.length < bytes.length,
    bytes: Array.from(slice), hex: hex(slice), sha256: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))), hashScope: 'whole-file-original-bytes', limit: CLOUD_REPO_BYTE_LIMITS.sliceBytes }
}

async function stateDiff(input, env, context) {
  if (Object.keys(input).some(key => !['action', 'base'].includes(key)) || !validStateDiffBase(input.base)) fail('STATE_DIFF_BASE_INVALID')
  if (context.bootstrap?.ready !== true) fail('BOOTSTRAP_REQUIRED', 503)
  const read = (name, path, body) => withDeadline(context.signal, async signal => {
    if (!env[name]) fail('STATE_DIFF_METADATA_UNAVAILABLE', 503)
    const response = await env[name].get(env[name].idFromName('node-main-v1')).fetch(new Request('https://x61.internal' + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': context.bootstrap.head.seedId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
    }))
    const value = await boundedJson(response, 64 * 1024, signal)
    if (!response.ok || value?.ok !== true) {
      if (name === 'HEAD' && response.status === 409 && value?.code === 'STATE_DIFF_BASE_MISMATCH') fail('STATE_DIFF_BASE_MISMATCH', 409)
      fail('STATE_DIFF_METADATA_UNAVAILABLE', 503)
    }
    return value
  })
  const headBase = typeof input.base === 'string' ? { ballId: input.base } : input.base?.head
  const mirrorBase = typeof input.base === 'string' ? null : (input.base?.mirror ?? null)
  const [head, mirror] = await Promise.all([
    read('HEAD', '/_head/state-diff', headBase ? { base: headBase } : {}).then(value => projectHeadStateDiff(value, headBase)).catch(error => {
      if (error?.code === 'STATE_DIFF_BASE_MISMATCH') throw error
      return { state: 'unavailable', code: 'STATE_DIFF_HEAD_UNAVAILABLE' }
    }),
    read('MIRROR', '/_mirror/status?compact=1').then(value => {
      const current = { lineageId: value.lineageId, revision: value.revision }, base = mirrorBase
      if (!validMirrorIdentity(current)) fail('STATE_DIFF_METADATA_UNAVAILABLE', 503)
      if (base?.lineageId === current.lineageId && base.revision > current.revision) fail('STATE_DIFF_BASE_AHEAD', 409)
      return { state: 'available', basis: base ? 'caller-supplied-fence' : 'snapshot-only', base, current,
        changed: base ? base.lineageId !== current.lineageId || base.revision !== current.revision : null }
    }).catch(error => {
      if (error?.code === 'STATE_DIFF_BASE_AHEAD') throw error
      return { state: 'unavailable', code: 'STATE_DIFF_MIRROR_UNAVAILABLE' }
    }),
  ])
  const ok = head.state === 'available' && mirror.state === 'available' && (!input.base || head.entries.state === 'available')
  return { ok, action: 'state_diff', schema: 'x61-state-diff/v1', basis: input.base ? 'caller-baseline' : 'snapshot-only', atomicAcrossBindings: false,
    ...(typeof input.base === 'string' ? { base: input.base, current: head.current?.ballId ?? null, changed: head.entries?.changes ?? null } : {}),
    ...(!ok ? { code: 'STATE_DIFF_INCOMPLETE' } : {}), head, mirror }
}

async function githubFile(path, env, networkFetch, signal, revision = 'main') {
  if (!remotePathAllowed(path)) fail('REPO_PRIVATE_FALLBACK_REFUSED', 403)
  safeText(path, env, 1024)
  const pinned = await pinnedTree(revision, env, networkFetch, signal)
  return await githubFileAt(path, pinned, env, networkFetch, signal)
}

async function githubFileAt(path, pinned, env, networkFetch, signal, allowNonText = false) {
  if (!remotePathAllowed(path)) fail('REPO_PRIVATE_FALLBACK_REFUSED', 403)
  safeText(path, env, 1024)
  const entry = regularFile(pinned.tree, path)
  const value = await github(env, networkFetch, '/contents/' + encodePath(path) + '?ref=' + pinned.commitSha, signal, CLOUD_REPO_READ_LIMITS.encodedResponseBytes)
  if (!record(value) || value.type !== 'file' || value.path !== path || value.encoding !== 'base64' || typeof value.content !== 'string' || value.submodule_git_url || value.target || value.sha !== entry.sha) fail('BROKER_CONTENT_INVALID', 502)
  const decoded = decodeFileBytes(value.content.replace(/\n/g, ''), env, allowNonText)
  return { ...(decoded.nonText ? decoded : { content: decoded.content }), sha: value.sha, commitSha: pinned.commitSha }
}

const treePath = path => typeof path === 'string' && path.length > 0 && path.length <= 1024
  && !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').length <= 32 && path.split('/').every(part => part && part !== '.' && part !== '..')

async function readTree(ref, env, networkFetch, signal) {
  const value = await github(env, networkFetch, `/git/trees/${ref}?recursive=1`, signal, CLOUD_REPO_TREE_LIMITS.responseBytes)
  if (!record(value) || !SHA.test(value.sha) || typeof value.truncated !== 'boolean' || !Array.isArray(value.tree)
    || value.tree.length > CLOUD_REPO_TREE_LIMITS.entries || (SHA.test(ref) && value.sha !== ref)) fail('REPO_TREE_INVALID', 502)
  const entries = new Map()
  for (const item of value.tree) {
    if (!record(item) || !treePath(item.path) || !SHA.test(item.sha) || !['blob', 'tree', 'commit'].includes(item.type)
      || !['100644', '100755', '040000', '120000', '160000'].includes(item.mode) || entries.has(item.path)
      || (item.type === 'tree') !== (item.mode === '040000') || (item.type === 'commit') !== (item.mode === '160000')
      || (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0))) fail('REPO_TREE_INVALID', 502)
    entries.set(item.path, { path: item.path, sha: item.sha, type: item.type, mode: item.mode, ...(item.size === undefined ? {} : { size: item.size }) })
  }
  return { sha: value.sha, truncated: value.truncated, entries }
}

async function pinnedTree(ref, env, networkFetch, signal) {
  if (ref !== 'main' && !SHA.test(ref) && !validAumaBranch(ref)) fail('REPO_BASE_SHA_REQUIRED')
  const commit = await github(env, networkFetch, '/commits/' + encodeURIComponent(ref), signal)
  if (!record(commit) || !SHA.test(commit.sha) || !SHA.test(commit.commit?.tree?.sha) || (SHA.test(ref) && commit.sha !== ref)) fail('BROKER_RESPONSE_INVALID', 502)
  return { commitSha: commit.sha, tree: await readTree(commit.commit.tree.sha, env, networkFetch, signal) }
}

function regularFile(tree, path, allowMissing = false) {
  const parts = path.split('/')
  for (let index = 1; index < parts.length; index++) {
    const parent = tree.entries.get(parts.slice(0, index).join('/'))
    if (!parent) {
      if (allowMissing && !tree.truncated) return null
      fail(tree.truncated ? 'REPO_TREE_INCOMPLETE' : 'REPO_TREE_INVALID', 502)
    }
    if (parent.mode !== '040000') fail('REPO_NONREGULAR_PATH_REFUSED', 403)
  }
  const entry = tree.entries.get(path)
  if (!entry) {
    if (allowMissing && !tree.truncated) return null
    fail(tree.truncated ? 'REPO_TREE_INCOMPLETE' : 'BROKER_NOT_FOUND', tree.truncated ? 502 : 404)
  }
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('REPO_NONREGULAR_PATH_REFUSED', 403)
  return entry
}

async function repositoryTree(prefix, env, networkFetch, signal) {
  if (prefix !== undefined && (!canonicalPath(prefix) || !(sourceRoots.has(prefix) || remotePathAllowed(prefix)))) fail('REPO_PATH_REFUSED', 403)
  const tree = await readTree('main', env, networkFetch, signal), entries = []
  let matched = 0, projectedBytes = 0
  for (const entry of tree.entries.values()) {
    if (!(remotePathAllowed(entry.path) || sourceRoots.has(entry.path)) || (prefix !== undefined && entry.path !== prefix && !entry.path.startsWith(prefix + '/'))
      || !['040000', '100644', '100755'].includes(entry.mode)) continue
    const parts = entry.path.split('/')
    if (parts.slice(0, -1).some((_part, index) => tree.entries.get(parts.slice(0, index + 1).join('/'))?.mode !== '040000')) continue
    matched++
    const projected = { path: entry.path, type: entry.type, sha: entry.sha, ...(entry.size === undefined ? {} : { size: entry.size }) }
    const bytes = size(JSON.stringify(projected)) + 1
    if (entries.length < CLOUD_REPO_TREE_LIMITS.returnedEntries && projectedBytes + bytes <= CLOUD_REPO_TREE_LIMITS.projectedBytes) { entries.push(projected); projectedBytes += bytes }
  }
  return { branch: BRANCH, treeSha: tree.sha, entries, filtered: true, truncated: tree.truncated || matched > entries.length, upstreamTruncated: tree.truncated, limit: CLOUD_REPO_TREE_LIMITS.returnedEntries, byteLimit: CLOUD_REPO_TREE_LIMITS.projectedBytes }
}

function projectCommit(value, env) {
  if (!record(value) || !SHA.test(value.sha) || !record(value.commit) || typeof value.commit.message !== 'string') fail('BROKER_RESPONSE_INVALID', 502)
  return { sha: value.sha, message: safeText(value.commit.message, env, 8192), parentSha: Array.isArray(value.parents) && value.parents.length === 1 && SHA.test(value.parents[0]?.sha) ? value.parents[0].sha : null, url: `https://github.com/${REPOSITORY}/commit/${value.sha}` }
}

async function commits(env, networkFetch, signal, limit = 10) {
  const value = await github(env, networkFetch, `/commits?sha=main&per_page=${limit}`, signal)
  if (!Array.isArray(value) || !value.length || value.length > limit) fail('BROKER_RESPONSE_INVALID', 502)
  return value.map(item => projectCommit(item, env))
}

async function mainComparison(base, main, env, networkFetch, signal) {
  // GitHub includes file patches even when only ancestry is needed. Keep that
  // response finite without making its capped files list authoritative.
  const value = await github(env, networkFetch, `/compare/${base}...${main}`, signal, 8 * 1024 * 1024)
  // One bounded immutable comparison establishes ancestry. Truncated commit
  // listings never justify walking arbitrary history or accepting another branch.
  if (!record(value) || value.base_commit?.sha !== base || value.merge_base_commit?.sha !== base
    || !['ahead', 'identical'].includes(value.status) || value.behind_by !== 0 || !Number.isSafeInteger(value.ahead_by) || value.ahead_by < 0
    || (base === main ? value.status !== 'identical' || value.ahead_by !== 0 : value.status !== 'ahead' || value.ahead_by === 0)) fail('REPO_MAIN_ANCESTRY_REQUIRED', 403)
  return value
}

async function comparison(base, path, env, networkFetch, signal, head = 'main') {
  if (!SHA.test(base)) fail('REPO_BASE_SHA_REQUIRED')
  if (head !== 'main') fail('GITHUB_ENDPOINT_REFUSED', 403)
  if (path !== undefined) { requirePath(path); if (!remotePathAllowed(path)) fail('REPO_PRIVATE_FALLBACK_REFUSED', 403) }
  const after = await pinnedTree('main', env, networkFetch, signal)
  const value = await mainComparison(base, after.commitSha, env, networkFetch, signal)
  const before = base === after.commitSha ? after : await pinnedTree(base, env, networkFetch, signal)
  if (!record(value) || !Array.isArray(value.files) || value.files.length > 300) fail('BROKER_RESPONSE_INVALID', 502)
  const files = value.files.filter(file => record(file) && remotePathAllowed(file.filename) && (file.previous_filename === undefined || remotePathAllowed(file.previous_filename)) && (path === undefined || path === file.filename)).map(file => {
    if (typeof file.status !== 'string' || !['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'].includes(file.status)) fail('BROKER_RESPONSE_INVALID', 502)
    if (['renamed', 'copied'].includes(file.status) && typeof file.previous_filename !== 'string') fail('BROKER_RESPONSE_INVALID', 502)
    if (file.status !== 'added') regularFile(before.tree, file.previous_filename ?? file.filename)
    if (file.status !== 'removed') regularFile(after.tree, file.filename)
    return { path: file.filename, status: file.status, patch: file.patch === undefined ? null : safeText(file.patch, env) }
  })
  return { base, head: after.commitSha, files, filtered: true, truncated: value.files.length === 300 }
}

async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Authorize repository publication from the host's consumed exact-action approval.
 * The broker independently validates the full route binding before calling this provider.
 * This permits source publication only, never HEAD selection or runtime execution.
 * @param {object} terms Broker-created immutable terms and the trusted consumption result.
 * @returns {object} Exact publication authorization, or a refusal.
 */
export function approveConsumedRepoPublication({ canonical, requestDigest, consumedApproval }) {
  if (consumedApproval?.ok !== true || consumedApproval.binding?.bodySha256 !== requestDigest) fail('OWNER_APPROVAL_REQUIRED', 403)
  return Object.freeze({ approved: true, canonical })
}

async function publication(input, env, context) {
  const { networkFetch, approveRepoPublication, authorizeClass3, request, signal, now } = context
  if (typeof approveRepoPublication !== 'function') fail('OWNER_APPROVAL_REQUIRED', 403)
  if (!SHA.test(input.expectedHeadSha)) fail('REPO_BASE_SHA_REQUIRED')
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)) fail('REPO_IDEMPOTENCY_KEY_REQUIRED')
  const message = safeText(input.message, env, 1024)
  if (!message.trim() || /[\r\n]/.test(message)) fail('REPO_COMMIT_MESSAGE_INVALID')
  const changes = input.action === 'write' ? [{ path: input.path, content: input.content }] : input.changes
  if (!Array.isArray(changes) || !changes.length || changes.length > CLOUD_BROKER_LIMITS.files) fail('REPO_EXPLICIT_CHANGES_REQUIRED')
  let bytes = 0
  const files = changes.map(change => {
    if (!record(change) || Object.keys(change).some(key => !['path', 'content'].includes(key))) fail('REPO_CHANGE_INVALID')
    const path = safeText(requirePath(change.path, true), env, 1024), content = safeText(change.content, env)
    bytes += size(content)
    return Object.freeze({ path, content })
  }).sort((a, b) => a.path.localeCompare(b.path))
  if (bytes > CLOUD_BROKER_LIMITS.publicationBytes || new Set(files.map(file => file.path)).size !== files.length) fail('REPO_CHANGE_INVALID')
  githubHeaders(env)
  // No callback may change the request after its exact bytes have been approved.
  freezeJson(input)
  const descriptors = await Promise.all(files.map(async file => Object.freeze({ path: file.path, sha256: await sha256(file.content), bytes: size(file.content) })))
  const binding = Object.freeze({ schema: 'x61-repo-publication/v1', action: input.action, repository: REPOSITORY, branch: BRANCH, expectedHeadSha: input.expectedHeadSha, idempotencyKey: input.idempotencyKey, message, files: Object.freeze(descriptors) })
  const canonical = canonicalJson(binding), publicationDigest = await sha256(canonical)
  const requestDigest = await sha256(canonicalJson(input)), url = new URL(request.url)
  const expectedApprovalBinding = { schema: 'aukora.class3.action.v1', audience: url.origin, method: request.method, pathname: url.pathname, bodySha256: requestDigest }
  if (typeof authorizeClass3 !== 'function') fail('CLASS3_WEBAUTHN_REQUIRED', 403)
  const consumedApproval = freezeJson(structuredClone(await authorizeClass3(input)))
  if (consumedApproval?.ok !== true || consumedApproval.binding?.bodySha256 !== requestDigest
    || canonicalJson(consumedApproval.binding) !== canonicalJson(expectedApprovalBinding)
    || !Number.isSafeInteger(consumedApproval.expiresAt) || consumedApproval.expiresAt <= now()) fail('CLASS3_WEBAUTHN_REQUIRED', 403)
  let approval
  try { approval = await approveRepoPublication(Object.freeze({ binding, canonical, requestDigest, publicationDigest, consumedApproval, files: Object.freeze(files) })) }
  catch (_error) { fail('OWNER_APPROVAL_REQUIRED', 403) }
  if (!record(approval) || Object.getOwnPropertyDescriptor(approval, 'approved')?.value !== true || Object.getOwnPropertyDescriptor(approval, 'canonical')?.value !== canonical) fail('OWNER_APPROVAL_REQUIRED', 403)
  if (consumedApproval.expiresAt <= now()) fail('CLASS3_APPROVAL_EXPIRED', 403)
  const marker = `X61-Publication: ${publicationDigest}`
  const requestMarker = `X61-Request: ${await sha256(input.idempotencyKey)}`
  const history = await commits(env, networkFetch, signal)
  const replay = history.find(commit => commit.message.split('\n').includes(marker))
  if (replay) {
    if (replay.parentSha !== input.expectedHeadSha || replay.message !== `${message}\n\n${marker}\n${requestMarker}`) fail('REPO_REPLAY_CONFLICT', 409)
    const detail = await github(env, networkFetch, '/commits/' + replay.sha, signal)
    if (detail?.sha !== replay.sha || !Array.isArray(detail.parents) || detail.parents.length !== 1 || detail.parents[0]?.sha !== input.expectedHeadSha || !Array.isArray(detail.files) || detail.files.length !== files.length
      || detail.files.some(file => !record(file) || !['added', 'modified'].includes(file.status) || !files.some(expected => expected.path === file.filename)) || new Set(detail.files.map(file => file.filename)).size !== files.length) fail('REPO_REPLAY_CONFLICT', 409)
    for (const file of files) {
      const remote = await githubFile(file.path, env, networkFetch, signal, replay.sha)
      if (remote.content !== file.content) fail('REPO_REPLAY_CONFLICT', 409)
    }
    return { ok: true, action: input.action, mode: 'atomic-main-publication', branch: BRANCH, commit: replay.sha, headSha: history[0].sha, paths: files.map(file => file.path), replayed: true, stdout: replay.sha, stderr: '' }
  }
  if (history.some(commit => commit.message.split('\n').includes(requestMarker))) fail('REPO_REPLAY_CONFLICT', 409)
  if (history[0].sha !== input.expectedHeadSha) fail('REPO_HEAD_CONFLICT', 409)
  const baseTree = await pinnedTree(input.expectedHeadSha, env, networkFetch, signal)
  for (const file of files) regularFile(baseTree.tree, file.path, true)
  if (consumedApproval.expiresAt <= now()) fail('CLASS3_APPROVAL_EXPIRED', 403)
  // expectedHeadOid is GitHub's atomic compare-and-swap. REST ref PATCH is only fast-forward.
  const query = 'mutation X61Publish($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }'
  const additions = files.map(file => ({ path: file.path, contents: btoa(Array.from(encoder.encode(file.content), byte => String.fromCharCode(byte)).join('')) }))
  context.repoMutationDispatched = true
  const result = await upstream(networkFetch, 'https://api.github.com/graphql', { method: 'POST', headers: githubHeaders(env), body: JSON.stringify({ query, variables: { input: { branch: { repositoryNameWithOwner: REPOSITORY, branchName: BRANCH }, expectedHeadOid: input.expectedHeadSha, message: { headline: message, body: marker + '\n' + requestMarker }, fileChanges: { additions }, clientMutationId: publicationDigest } } }) }, signal, true)
  if (Array.isArray(result?.errors) && result.errors.length) fail('REPO_PUBLICATION_OUTCOME_UNKNOWN', 503, { outcome: 'unknown', retry: 'repeat-the-identical-request-to-reconcile' })
  const commit = result?.data?.createCommitOnBranch?.commit?.oid
  if (!SHA.test(commit)) fail('REPO_PUBLICATION_OUTCOME_UNKNOWN', 503, { outcome: 'unknown', retry: 'repeat-the-identical-request-to-reconcile' })
  return { ok: true, action: input.action, mode: 'atomic-main-publication', branch: BRANCH, commit, headSha: commit, paths: files.map(file => file.path), replayed: false, stdout: commit, stderr: '' }
}

const validAumaBranch = branch => typeof branch === 'string' && AUMA_BRANCH_RE.test(branch) && !branch.includes('..') && !branch.endsWith('.') && !branch.endsWith('.lock')
const validProposalBranch = branch => validAumaBranch(branch) && /^auma\/proposal\/[a-z0-9][a-z0-9._-]{1,60}$/.test(branch)
const repoRef = value => value === undefined ? 'main' : value === 'main' || validAumaBranch(value) ? value : fail('REPO_BRANCH_REFUSED', 403)
const ordered = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
const exactFields = (input, fields) => { if (Object.keys(input).some(key => !fields.includes(key))) fail('BROKER_QUERY_INVALID') }

function requireOwner(env, context) {
  const access = context.access, now = context.now()
  const email = value => typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value)
  if (access?.type !== 'owner' || !email(access.email) || !email(env.OWNER_EMAIL) || access.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()
    || !Number.isSafeInteger(now) || now < 1 || !Number.isFinite(access.expires) || access.expires * 1000 <= now) fail('OWNER_SESSION_REQUIRED', 403)
}

/** A path on her branches, as judged before the fence: .github/ refused, the path canonical and publishable. */
function branchPathName(path, env) {
  if (typeof path === 'string' && (path === '.github' || path.startsWith('.github/'))) fail('REPO_WORKFLOW_PATH_REFUSED', 403)
  return safeText(requirePath(path, true), env, 1024)
}

/** Refuse a proposal path by the one judgement of deploy/ci/frozen-paths.mjs (plain, frozen, test main has, open). */
function refuseProposalPath(path, status, twin = false) {
  const refusal = proposalPathRefusal(path, status, { twin })
  if (refusal) fail(refusal.code, 403, { protectedPath: path, next: refusal.next })
}

/** Her branches carry only plain, open, unfrozen paths (deploy/ci/frozen-paths.mjs): refused at write, before anything
 * reaches GitHub. A write cannot tell an addition from a change relative to main, so it is judged as an addition (a new
 * test file may be written); stage, merge and CI judge the real status with both trees in hand. */
function branchPath(path, env) {
  if (typeof path === 'string' && path.length > 0 && !isPlainRepoPath(path)) refuseProposalPath(path, 'added')
  const canonical = branchPathName(path, env)
  refuseProposalPath(canonical, 'added')
  return canonical
}

function readablePath(path) {
  if (typeof path === 'string' && path.startsWith('/dsh/home/auma/')) path = 'mirror/home/auma/' + path.slice('/dsh/home/auma/'.length)
  else if (typeof path === 'string' && path.startsWith('/dsh/workspace/')) path = path.slice('/dsh/workspace/'.length)
  return requirePath(path)
}

async function sourceText(path, source, ref, env, context, pinned, allowNonText = false) {
  if (!['auto', 'mirror', 'github'].includes(source)) fail('BROKER_QUERY_INVALID')
  if (source === 'mirror' && (ref !== 'main' || !liveMirrorPath(path))) fail('REPO_MIRROR_REF_REFUSED', 403)
  if (ref === 'main' && source !== 'github' && liveMirrorPath(path)) {
    const value = await mirrorRead(path, env, context.bootstrap.head.seedId, context.signal)
    if (value.kind === 'file') {
      const decoded = decodeFileBytes(value.b64, env, allowNonText)
      return { ...(decoded.nonText ? decoded : { content: decoded.content }), source: 'mirror', lineageId: value.lineageId, revision: value.revision }
    }
    if (value.kind === 'gone') fail('REPO_PATH_DELETED', 404)
    if (value.kind === 'dir') fail('REPO_FILE_REQUIRED', 409)
    if (source === 'mirror') fail('BROKER_NOT_FOUND', 404)
  }
  return { ...await githubFileAt(path, pinned ?? await pinnedTree(ref, env, context.networkFetch, context.signal), env, context.networkFetch, context.signal, allowNonText), source: 'github' }
}

// A common-prefix/suffix hunk is deterministic and valid, though not necessarily
// minimal. Its work is linear in file bytes; no unbounded edit-distance matrix.
function lineDiff(left, right, leftPath, rightPath, contextLines = 3) {
  const lines = text => text === '' ? [] : text.match(/[^\n]*\n|[^\n]+$/g)
  const a = lines(left), b = lines(right)
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const deletions = a.length - prefix - suffix, additions = b.length - prefix - suffix
  if (left === right) return { diff: '', additions: 0, deletions: 0 }
  const start = Math.max(0, prefix - contextLines), trailing = Math.min(suffix, contextLines)
  const countA = a.length - suffix + trailing - start, countB = b.length - suffix + trailing - start
  const emit = (marker, line) => marker + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')
  let diff = `--- ${leftPath}\n+++ ${rightPath}\n@@ -${countA ? start + 1 : start},${countA} +${countB ? start + 1 : start},${countB} @@\n`
  for (let i = start; i < prefix; i++) diff += emit(' ', a[i])
  for (let i = prefix; i < a.length - suffix; i++) diff += emit('-', a[i])
  for (let i = prefix; i < b.length - suffix; i++) diff += emit('+', b[i])
  for (let i = 0; i < trailing; i++) diff += emit(' ', a[a.length - suffix + i])
  return { diff, additions, deletions }
}

async function compareFiles(input, env, context) {
  exactFields(input, ['action', 'leftPath', 'rightPath', 'leftSource', 'rightSource', 'ref', 'contextLines'])
  const leftPath = readablePath(input.leftPath), rightPath = readablePath(input.rightPath)
  const ref = SHA.test(input.ref) ? input.ref : repoRef(input.ref)
  const contextLines = input.contextLines ?? 3
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20) fail('BROKER_QUERY_INVALID')
  const leftSource = input.leftSource ?? 'auto', rightSource = input.rightSource ?? 'auto'
  if (![leftSource, rightSource].every(source => ['auto', 'mirror', 'github'].includes(source))) fail('BROKER_QUERY_INVALID')
  const pinned = leftSource === 'mirror' && rightSource === 'mirror' ? undefined : await pinnedTree(ref, env, context.networkFetch, context.signal)
  const left = await sourceText(leftPath, leftSource, ref, env, context, pinned)
  const right = await sourceText(rightPath, rightSource, ref, env, context, pinned)
  // The two-file comparison wire contract stays at 256 KiB per side even though
  // branch source reads and edits admit larger core implementation files.
  if (size(left.content) > 256 * 1024 || size(right.content) > 256 * 1024) fail('BROKER_BODY_TOO_LARGE', 413)
  if (left.source === 'mirror' && right.source === 'mirror' && (left.lineageId !== right.lineageId || left.revision !== right.revision)) fail('REPO_MIRROR_CHANGED', 409)
  const { diff } = lineDiff(left.content, right.content, leftPath, rightPath, contextLines)
  return { ok: true, identical: left.content === right.content, leftBytes: size(left.content), rightBytes: size(right.content), diff: safeText(diff, env, 4 * CLOUD_REPO_READ_LIMITS.fileBytes) }
}

function searchMatcher(input, env) {
  const query = safeText(input.query, env, 128)
  if (!query || (input.regex !== undefined && typeof input.regex !== 'boolean') || (input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean')) fail('REPO_SEARCH_QUERY_INVALID')
  if (!input.regex) {
    const needle = input.caseSensitive ? query : query.toLowerCase()
    return line => (input.caseSensitive ? line : line.toLowerCase()).includes(needle)
  }
  // No repetition, groups or alternation: at most 128 fixed-width atoms are
  // tested at each input offset. Backtracking cannot grow with input length.
  let inClass = false
  for (let i = 0; i < query.length; i++) {
    const char = query[i]
    if (char === '\\') {
      const next = query[++i]
      if (!next || !/[dDsSwW\\.\[\](){}*+?|^$\/-]/.test(next)) fail('REPO_SEARCH_REGEX_UNSUPPORTED')
    } else if (char === '[' && !inClass) inClass = true
    else if (char === ']' && inClass) inClass = false
    else if (!inClass && /[()*+?{}|]/.test(char)) fail('REPO_SEARCH_REGEX_UNSUPPORTED')
  }
  if (inClass) fail('REPO_SEARCH_REGEX_UNSUPPORTED')
  let expression
  try { expression = new RegExp(query, input.caseSensitive ? 'u' : 'iu') } catch (_error) { fail('REPO_SEARCH_REGEX_UNSUPPORTED') }
  return line => expression.test(line)
}

async function mirrorInventory(env, context) {
  if (!env.MIRROR) fail('CLOUD_BINDING_MISSING', 503)
  const value = await withDeadline(context.signal, async signal => {
    const response = await env.MIRROR.get(env.MIRROR.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_mirror/status', {
      headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': context.bootstrap.head.seedId }, signal,
    }))
    if (!response.ok) fail('REPO_MIRROR_READ_FAILED', 503)
    return await boundedJson(response, 4 * 1024 * 1024, signal)
  })
  if (value?.ok !== true || !validMirrorIdentity({ lineageId: value.lineageId, revision: value.revision }) || !Array.isArray(value.homeFiles) || !Array.isArray(value.workspaceFiles)
    || value.homeFiles.length + value.workspaceFiles.length > 20000 || [...value.homeFiles, ...value.workspaceFiles].some(path => typeof path !== 'string')) fail('REPO_MIRROR_READ_INVALID', 503)
  return { ...value, paths: [...value.homeFiles.map(path => 'mirror/home/' + path), ...value.workspaceFiles].filter(path => repoPathAllowed(path) && liveMirrorPath(path)) }
}

async function searchRepository(input, env, context) {
  exactFields(input, ['action', 'query', 'regex', 'caseSensitive', 'prefix', 'branch', 'maxMatches'])
  const ref = repoRef(input.branch), matchesLine = searchMatcher(input, env), maxMatches = input.maxMatches ?? 200
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 200) fail('REPO_SEARCH_QUERY_INVALID')
  if (input.prefix !== undefined && (!canonicalPath(input.prefix) || !(sourceRoots.has(input.prefix) || repoPathAllowed(input.prefix)))) fail('REPO_PATH_REFUSED', 403)
  return await withDeadline(context.signal, async signal => {
    const local = { ...context, signal }, pinned = await pinnedTree(ref, env, context.networkFetch, signal)
    const inventory = ref === 'main' ? await mirrorInventory(env, local) : null
    const candidates = new Set([...pinned.tree.entries.values()].filter(entry => remotePathAllowed(entry.path) && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)).map(entry => entry.path))
    for (const path of inventory?.paths ?? []) candidates.add(path)
    const paths = ordered(candidates).filter(path => input.prefix === undefined || path === input.prefix || path.startsWith(input.prefix + '/'))
    const matches = [], skippedPaths = []; let scannedBytes = 0, projectedBytes = 0, filesScanned = 0, truncated = pinned.tree.truncated, skippedFiles = 0, skippedBytes = 0
    let screenedOut = 0
    for (const path of paths) {
      if (filesScanned >= CLOUD_REPO_PROPOSAL_LIMITS.searchFiles || scannedBytes >= CLOUD_REPO_PROPOSAL_LIMITS.searchBytes) { truncated = true; break }
      let value
      try { value = await sourceText(path, 'auto', ref, env, local, pinned, true) }
      catch (error) {
        if (['REPO_PATH_DELETED', 'REPO_FILE_REQUIRED'].includes(error?.code)) continue
        throw error
      }
      if (value.source === 'mirror' && (value.lineageId !== inventory.lineageId || value.revision !== inventory.revision)) fail('REPO_MIRROR_CHANGED', 409)
      filesScanned++; scannedBytes += value.nonText ? value.byteLength : size(value.content)
      if (scannedBytes > CLOUD_REPO_PROPOSAL_LIMITS.searchBytes) { truncated = true; break }
      if (value.nonText) {
        skippedFiles++
        const skipped = { path: safeText(path, env, 1024), reason: value.nonText }, bytes = size(JSON.stringify(skipped))
        if (skippedPaths.length < 32 && skippedBytes + bytes <= 8192) { skippedPaths.push(skipped); skippedBytes += bytes }
        continue
      }
      // The cloud wake screens each file's EXACT bytes here, the same bytes its lines are taken from (an independent
      // review: a later re-read of mutable content could release a line whose original file held a credential).
      if (typeof context.screenFile === 'function' && context.screenFile(value.content) !== true) { screenedOut++; continue }
      const lines = value.content.split('\n')
      for (let index = 0; index < lines.length; index++) {
        if (!matchesLine(lines[index])) continue
        const match = { path, line: index + 1, text: lines[index] }
        const bytes = size(JSON.stringify(match))
        if (matches.length === maxMatches || projectedBytes + bytes > CLOUD_REPO_TREE_LIMITS.projectedBytes) { truncated = true; break }
        matches.push(match); projectedBytes += bytes
      }
      if (matches.length === maxMatches || projectedBytes >= CLOUD_REPO_TREE_LIMITS.projectedBytes) { truncated = true; break }
    }
    return { ok: true, matches, truncated, filesScanned, skippedFiles, skippedPaths, skippedPathsTruncated: skippedFiles > skippedPaths.length,
      ...(typeof context.screenFile === 'function' ? { screenedOut } : {}) }
  })
}

async function repositoryId(env, context) {
  const value = await github(env, context.networkFetch, '', context.signal)
  if (value?.full_name !== REPOSITORY || value.default_branch !== 'main' || typeof value.node_id !== 'string' || !/^[A-Za-z0-9_=-]{1,200}$/.test(value.node_id)) fail('BROKER_RESPONSE_INVALID', 502)
  return value.node_id
}

async function branchHead(branch, env, context, allowMissing = false) {
  let value
  try { value = await github(env, context.networkFetch, '/git/ref/heads/' + encodePath(branch), context.signal) }
  catch (error) { if (allowMissing && error?.code === 'BROKER_NOT_FOUND') return null; throw error }
  if (value?.ref !== 'refs/heads/' + branch || value.object?.type !== 'commit' || !SHA.test(value.object.sha)) fail('REPO_REF_INVALID', 502)
  return value.object.sha
}

async function updateRefs(updates, id, env, context) {
  const clientMutationId = await sha256(canonicalJson({ id, updates }))
  const query = 'mutation X61UpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }'
  requireOwner(env, context)
  if (context.repoApprovalExpiresAt !== undefined && context.repoApprovalExpiresAt <= context.now()) fail('CLASS3_APPROVAL_EXPIRED', 403)
  if (context.signal.aborted) fail('BROKER_TIMEOUT', 408)
  // GraphQL updateRefs checks every beforeOid before applying its atomic batch.
  // A branch no-op preserves the approved head while checking that exact ref.
  context.refMutationDispatched = true
  const result = await upstream(context.networkFetch, 'https://api.github.com/graphql', {
    method: 'POST', headers: githubHeaders(env), body: JSON.stringify({ query, variables: { input: { repositoryId: id, refUpdates: updates, clientMutationId } } }),
  }, context.signal)
  // GraphQL null data or resolver errors do not prove the mutation had no
  // effects. Never release a durable merge claim on ambiguous provider errors.
  if (result?.errors?.length || result?.data?.updateRefs?.clientMutationId !== clientMutationId) fail('REPO_REF_OUTCOME_UNKNOWN', 503)
}

async function branchOperation(input, env, context) {
  requireOwner(env, context)
  const branch = repoRef(input.branch)
  if (!validAumaBranch(branch)) fail('REPO_BRANCH_REFUSED', 403)
  if (input.action === 'branch_create' || input.action === 'branch_delete') {
    exactFields(input, ['action', 'branch', 'fromSha', 'ownerSession'])
    if (input.action === 'branch_delete' && input.fromSha !== undefined) fail('BROKER_QUERY_INVALID')
    if (input.fromSha !== undefined && !SHA.test(input.fromSha)) fail('REPO_BASE_SHA_REQUIRED')
    const current = await branchHead(branch, env, context, true)
    if (input.action === 'branch_create' && current !== null) {
      if (input.fromSha !== undefined && input.fromSha !== current) fail('REPO_REF_CONFLICT', 409)
      return { ok: true, action: input.action, branch, headSha: current, created: false }
    }
    if (input.action === 'branch_delete' && current === null) return { ok: true, action: input.action, branch, deleted: false }
    let after = ZERO_SHA
    if (input.action === 'branch_create') {
      const main = await branchHead('main', env, context)
      after = input.fromSha ?? main
      if (after !== main) await mainComparison(after, main, env, context.networkFetch, context.signal)
    }
    const id = await repositoryId(env, context)
    await updateRefs([{ name: 'refs/heads/' + branch, beforeOid: current ?? ZERO_SHA, afterOid: after, force: false }], id, env, context)
    const actual = await branchHead(branch, env, context, input.action === 'branch_delete')
    if (actual !== (input.action === 'branch_delete' ? null : after)) fail('REPO_REF_OUTCOME_UNKNOWN', 503)
    return { ok: true, action: input.action, branch, ...(input.action === 'branch_create' ? { created: true, headSha: after } : { deleted: true }) }
  }
  exactFields(input, ['action', 'branch', 'path', 'content', 'oldString', 'newString', 'changes', 'message', 'dryRun', 'expectedHeadSha', 'ownerSession'])
  if (!['write', 'edit', 'commit'].includes(input.action)) fail('REPO_ACTION_UNAVAILABLE')
  if (input.expectedHeadSha !== undefined && !SHA.test(input.expectedHeadSha)) fail('REPO_BASE_SHA_REQUIRED')
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') fail('BROKER_QUERY_INVALID')
  let content, path, files
  if (input.action !== 'commit') path = branchPath(input.path, env)
  if (input.action === 'write') content = safeText(input.content, env, CLOUD_REPO_BRANCH_LIMITS.fileBytes)
  if (input.action === 'edit') {
    safeText(input.oldString, env, CLOUD_REPO_BRANCH_LIMITS.fileBytes); safeText(input.newString, env, CLOUD_REPO_BRANCH_LIMITS.fileBytes)
    if (!input.oldString) fail('REPO_EDIT_TARGET_EMPTY')
  }
  if (input.action === 'commit') {
    if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > CLOUD_BROKER_LIMITS.files) fail('REPO_EXPLICIT_CHANGES_REQUIRED')
    files = input.changes.map(change => {
      if (!record(change)) fail('REPO_CHANGE_INVALID')
      exactFields(change, ['path', 'content'])
      return { path: branchPath(change.path, env), content: safeText(change.content, env, CLOUD_REPO_BRANCH_LIMITS.fileBytes) }
    })
    if (new Set(files.map(file => file.path)).size !== files.length || files.reduce((total, file) => total + size(file.content), 0) > CLOUD_REPO_BRANCH_LIMITS.publicationBytes) fail('REPO_CHANGE_INVALID')
  }
  const current = await branchHead(branch, env, context)
  if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== current) fail('REPO_HEAD_CONFLICT', 409)
  const pinned = await pinnedTree(current, env, context.networkFetch, context.signal)
  if (pinned.tree.truncated) fail('REPO_TREE_INCOMPLETE', 502)
  if (input.action === 'edit') {
    const prior = (await githubFileAt(path, pinned, env, context.networkFetch, context.signal)).content
    const index = prior.indexOf(input.oldString)
    if (index === -1) fail('REPO_EDIT_TARGET_NOT_FOUND', 409)
    if (prior.indexOf(input.oldString, index + input.oldString.length) !== -1) fail('REPO_EDIT_TARGET_AMBIGUOUS', 409)
    content = safeText(prior.slice(0, index) + input.newString + prior.slice(index + input.oldString.length), env, CLOUD_REPO_BRANCH_LIMITS.fileBytes)
  }
  if (input.action !== 'commit') files = [{ path, content }]
  for (const file of files) regularFile(pinned.tree, file.path, true)
  // A case twin of a path already on her branch (one file on a case-insensitive disk) is refused here too (MUST 1).
  for (const path of caseTwinPaths(files.map(file => file.path), pinned.tree.entries.keys())) refuseProposalPath(path, 'added', true)
  if (input.action !== 'commit' && input.message === undefined) return { ok: true, action: input.action, branch, path, content, baseSha: current, bytesWritten: size(content), staged: input.dryRun !== true, scope: 'caller', ...(input.dryRun ? { dryRun: true } : {}) }
  const message = safeText(input.message, env, 1024)
  if (!message.trim() || /[\r\n]/.test(message)) fail('REPO_COMMIT_MESSAGE_INVALID')
  if (input.dryRun === true) return { ok: true, action: input.action, branch, baseSha: current, dryRun: true, committed: false, paths: files.map(file => file.path) }
  const query = 'mutation X61Publish($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }'
  const additions = files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => ({ path: file.path, contents: btoa(Array.from(encoder.encode(file.content), byte => String.fromCharCode(byte)).join('')) }))
  requireOwner(env, context)
  if (context.signal.aborted) fail('BROKER_TIMEOUT', 408)
  context.refMutationDispatched = true
  const result = await upstream(context.networkFetch, 'https://api.github.com/graphql', { method: 'POST', headers: githubHeaders(env), body: JSON.stringify({ query, variables: { input: {
    branch: { repositoryNameWithOwner: REPOSITORY, branchName: branch }, expectedHeadOid: current, message: { headline: message }, fileChanges: { additions },
  } } }) }, context.signal)
  const commit = result?.data?.createCommitOnBranch?.commit?.oid
  if (result?.errors?.length || !SHA.test(commit)) fail('REPO_REF_OUTCOME_UNKNOWN', 503)
  if (await branchHead(branch, env, context) !== commit) fail('REPO_REF_OUTCOME_UNKNOWN', 503)
  return { ok: true, action: input.action, branch, commit, commitSha: commit, headSha: commit, paths: files.map(file => file.path), stdout: commit, stderr: '' }
}

/** Every changed path of a proposal, judged with both trees in hand (stage, merge, branch diff) by the one judgement of
 * deploy/ci/frozen-paths.mjs: plain (printable ASCII, no case twin in either tree), not frozen, not a test main already
 * has (changed or deleted), and open. Either side of a rename counts (it is a delete and an add here). `pathsOnly` judges
 * names and reads no file. `markFrozen` is for the branch diff, a read: it refuses nothing for the fence and marks each
 * such file with `refused` (its code) and `next` instead (`frozen: true` for a frozen one). */
async function inspectedChanges(before, after, env, context, allowEmpty = false, { pathsOnly = false, markFrozen = false } = {}) {
  if (before.tree.truncated || after.tree.truncated) fail('REPO_TREE_INCOMPLETE', 502)
  const paths = ordered(new Set([...before.tree.entries.keys(), ...after.tree.entries.keys()])), candidates = [], changed = []
  for (const path of paths) {
    const a = before.tree.entries.get(path), b = after.tree.entries.get(path)
    if (a && b && a.sha === b.sha && a.mode === b.mode && a.type === b.type) continue
    // Inspect every changed name before filtering directory metadata. Forbidden
    // renames/deletions and mode-only changes must not disappear from evidence.
    if (!canonicalPath(path) || path === '.github' || path.startsWith('.github/')) fail('REPO_PROPOSAL_PATH_REFUSED', 403)
    if ([a, b].every(entry => !entry || entry.type === 'tree')) continue
    candidates.push({ path, a, b })
  }
  const twins = new Set(caseTwinPaths(candidates.map(({ path }) => path), before.tree.entries.keys(), after.tree.entries.keys()))
  for (const { path, a, b } of candidates) {
    const status = !a ? 'added' : !b ? 'removed' : 'modified', refusal = proposalPathRefusal(path, status, { twin: twins.has(path) })
    if (refusal && !markFrozen) fail(refusal.code, 403, { protectedPath: path, next: refusal.next })
    if (refusal?.code !== 'REPO_PATH_NOT_PLAIN') branchPathName(path, env)
    if (a) regularFile(before.tree, path)
    if (b) regularFile(after.tree, path)
    changed.push({ path, status, ...(refusal ? { refused: refusal.code, next: refusal.next, ...(refusal.code === 'REPO_FROZEN_PATH_REFUSED' ? { frozen: true } : {}) } : {}) })
  }
  if (!changed.length && !allowEmpty) fail('REPO_PROPOSAL_EMPTY', 409)
  if (changed.length > CLOUD_REPO_PROPOSAL_LIMITS.files) fail('REPO_PROPOSAL_TOO_LARGE', 413)
  if (pathsOnly) return changed
  let bytes = 0
  for (const file of changed) {
    const left = file.status === 'added' ? '' : (await githubFileAt(file.path, before, env, context.networkFetch, context.signal)).content
    const right = file.status === 'removed' ? '' : (await githubFileAt(file.path, after, env, context.networkFetch, context.signal)).content
    bytes += size(left) + size(right)
    if (bytes > CLOUD_REPO_PROPOSAL_LIMITS.inspectedBytes) fail('REPO_PROPOSAL_TOO_LARGE', 413)
    const { additions, deletions } = lineDiff(left, right, file.path, file.path, 0)
    Object.assign(file, { additions, deletions, t2Protected: isT2ProtectedRepoPath(file.path) })
  }
  return changed
}

async function proposalEvidence(branch, env, context, expected) {
  const baseSha = await branchHead('main', env, context), headSha = await branchHead(branch, env, context)
  if (expected && (expected.baseSha !== baseSha || expected.headSha !== headSha)) fail('REPO_HEAD_CONFLICT', 409)
  if (baseSha === headSha) fail('REPO_PROPOSAL_EMPTY', 409)
  await mainComparison(baseSha, headSha, env, context.networkFetch, context.signal)
  const before = await pinnedTree(baseSha, env, context.networkFetch, context.signal), after = await pinnedTree(headSha, env, context.networkFetch, context.signal)
  if (expected && expected.treeSha !== after.tree.sha) fail('REPO_HEAD_CONFLICT', 409)
  return { baseSha, headSha, treeSha: after.tree.sha, changedFiles: await inspectedChanges(before, after, env, context) }
}

async function paginatedCi(path, key, env, context) {
  const result = [], ids = new Set(); let total
  for (let page = 1; page <= 10; page++) {
    const value = await github(env, context.networkFetch, path + (path.includes('?') ? '&' : '?') + `per_page=100&page=${page}`, context.signal, 1024 * 1024)
    if (!record(value) || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || value.total_count > 1000 || !Array.isArray(value[key]) || value[key].length > 100
      || (total !== undefined && total !== value.total_count)) fail('REPO_CI_INCOMPLETE', 502)
    total = value.total_count
    for (const item of value[key]) {
      if (!record(item) || !Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id)) fail('REPO_CI_INCOMPLETE', 502)
      ids.add(item.id); result.push(item)
    }
    if (result.length > total || value[key].length < 100 && result.length !== total) fail('REPO_CI_INCOMPLETE', 502)
    if (result.length === total) return result
  }
  fail('REPO_CI_INCOMPLETE', 502)
}

/** The two workflows whose results are a proposal's CI evidence, and the jobs each must have run: proposal-gate.yml runs
 * deploy-x61.yml's gates; proposal-checks.yml runs the fence (main's frozen list), every edge test, the UI suite and the
 * boot test. A merge needs both, for the exact head. */
export const PROPOSAL_GATE_WORKFLOW = Object.freeze({ file: 'proposal-gate.yml', path: '.github/workflows/proposal-gate.yml', jobs: Object.freeze(['preflight', 'build', 'scrub-dist', 'bundle']) })
export const PROPOSAL_CHECKS_WORKFLOW = Object.freeze({ file: 'proposal-checks.yml', path: '.github/workflows/proposal-checks.yml', jobs: Object.freeze(['checks']) })
export const PROPOSAL_CI_WORKFLOWS = Object.freeze([PROPOSAL_GATE_WORKFLOW, PROPOSAL_CHECKS_WORKFLOW])
const RUN_STATUSES = ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']
const RUN_CONCLUSIONS = ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']

/**
 * One workflow's evidence for a proposal head: ONLY its latest run for a push of this exact branch and commit, and every
 * one of its required jobs in that run attempt. Other checks on the commit are not evidence: an
 * unrelated green check with no run of this workflow is 'none'. 'passed' needs the run completed with success AND each
 * required job present once, completed with success. Malformed or incomplete provider answers throw REPO_CI_INCOMPLETE.
 * @returns {Promise<'passed'|'pending'|'failed'|'none'>}
 */
async function workflowCi(workflow, branch, headSha, env, context) {
  const runs = await paginatedCi(`/actions/workflows/${workflow.file}/runs?branch=${encodeURIComponent(branch)}&head_sha=${headSha}&event=push`, 'workflow_runs', env, context)
  let latest = null
  for (const run of runs) {
    if (run.head_sha !== headSha || run.head_branch !== branch || run.event !== 'push' || run.path !== workflow.path
      || !Number.isSafeInteger(run.run_number) || run.run_number < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || !RUN_STATUSES.includes(run.status) || !(run.conclusion === null || RUN_CONCLUSIONS.includes(run.conclusion))) fail('REPO_CI_INCOMPLETE', 502)
    if (!latest || run.run_number > latest.run_number || run.run_number === latest.run_number && run.run_attempt > latest.run_attempt) latest = run
  }
  if (!latest) return 'none'
  if (latest.status !== 'completed') return 'pending'
  if (latest.conclusion !== 'success') return 'failed'
  const jobs = await paginatedCi(`/actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs`, 'jobs', env, context)
  for (const job of jobs) {
    if (job.run_id !== latest.id || job.head_sha !== headSha || typeof job.name !== 'string' || !RUN_STATUSES.includes(job.status)
      || !(job.conclusion === null || RUN_CONCLUSIONS.includes(job.conclusion))) fail('REPO_CI_INCOMPLETE', 502)
  }
  for (const name of workflow.jobs) {
    const named = jobs.filter(job => job.name === name)
    if (named.length !== 1 || named[0].status !== 'completed' || named[0].conclusion !== 'success') return 'failed'
  }
  return 'passed'
}

/**
 * CI evidence for a proposal head: BOTH workflows of PROPOSAL_CI_WORKFLOWS under the same exact-run rules. 'passed' only
 * when both passed; 'failed' when either failed (a failed gate is not read further); 'none' when neither has a run;
 * else 'pending'. stage_proposal shows this same combined state, and merge_proposal reads it before the passkey.
 * @returns {Promise<'passed'|'pending'|'failed'|'none'>}
 */
async function proposalCi(branch, headSha, env, context) {
  const states = []
  for (const workflow of PROPOSAL_CI_WORKFLOWS) {
    const state = await workflowCi(workflow, branch, headSha, env, context)
    if (state === 'failed') return 'failed'
    states.push(state)
  }
  if (states.every(state => state === 'passed')) return 'passed'
  if (states.every(state => state === 'none')) return 'none'
  return 'pending'
}

const CI_STATES = Object.freeze(['passed', 'pending', 'failed', 'none'])
/** What to do when a merge is refused because the proposal's gate has not passed on its exact head. */
export const PROPOSAL_CI_NEXT = 'wait for both proposal-gate and proposal-checks to pass on this exact head, then stage_proposal again so the card shows it; a failed run of either needs a new commit on the branch'

/** One call to HEAD's repo-proposal route. `approval`: his Class 3 approval, sent only with begin_merge, which consumes it
 * in HEAD's own transaction. `signal`: a bookkeeping call's own limit, for settling after this call's deadline fired. A
 * refusal keeps HEAD's code; a 409's attempt age and a 403 of the passkey check reach the answer. */
async function headProposal(input, env, context, { approval = null, signal: own = null } = {}) {
  if (!env.HEAD || context.bootstrap?.ready !== true) fail('BOOTSTRAP_REQUIRED', 503)
  return await withDeadline(own ?? context.signal, async signal => {
    const response = await env.HEAD.get(env.HEAD.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_head/repo-proposal', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': context.bootstrap.head.seedId, 'x-x6-verified-access': JSON.stringify(context.access),
        ...(approval !== null && ['begin_merge', 'release_attempt'].includes(input.action) ? { 'x-x6-class3-approval': approval } : {}) },
      body: JSON.stringify(input), signal,
    }))
    const value = await boundedJson(response, 128 * 1024, signal)
    if (!response.ok || value?.ok !== true) {
      const code = typeof value?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : 'REPO_PROPOSAL_STORAGE_FAILED'
      const timing = ['ageMs', 'reconcileAfterMs', 'limit', 'unresolved'].filter(key => Number.isSafeInteger(value?.[key])).map(key => [key, value[key]])
      fail(code, response.status === 409 ? 409 : response.status === 403 && code.startsWith('CLASS3_') ? 403 : 503, {
        headAnswered: true, ...Object.fromEntries(timing), ...(value?.outcome === 'unknown' ? { outcome: 'unknown' } : {}), ...(releaseRef(value?.oldest) ? { oldest: releaseRef(value.oldest) } : {}) })
    }
    return value
  })
}

async function mergeBinding(input, context) {
  return { schema: 'aukora.class3.action.v1', audience: new URL(context.request.url).origin, method: 'POST', pathname: '/_host/repo', bodySha256: await sha256(canonicalJson(input)) }
}

async function stageProposal(input, env, context) {
  requireOwner(env, context)
  exactFields(input, ['action', 'branch', 'title', 'summary', 'ownerSession'])
  if (!validProposalBranch(input.branch)) fail('REPO_BRANCH_REFUSED', 403)
  const title = safeText(input.title, env, 200), summary = input.summary === undefined ? undefined : safeText(input.summary, env, 4000)
  if (!title.trim() || /[\u0000-\u001f\u007f]/.test(title)) fail('REPO_PROPOSAL_TITLE_INVALID')
  const evidence = await proposalEvidence(input.branch, env, context)
  const mergeBody = { action: 'merge_proposal', baseSha: evidence.baseSha, branch: input.branch, headSha: evidence.headSha, treeSha: evidence.treeSha }
  const proposal = { schema: 'aukora.staged-repo-proposal.v1', branch: input.branch, title, ...(summary === undefined ? {} : { summary }), ...evidence,
    ciStatus: await proposalCi(input.branch, evidence.headSha, env, context), stagedAt: context.now(), mergeBody, binding: await mergeBinding(mergeBody, context) }
  if (size(JSON.stringify(proposal)) > CLOUD_REPO_PROPOSAL_LIMITS.bytes) fail('REPO_PROPOSAL_TOO_LARGE', 413)
  safeText(JSON.stringify(proposal), env, CLOUD_REPO_PROPOSAL_LIMITS.bytes)
  await headProposal({ action: 'stage', proposal }, env, context)
  return { ok: true, action: input.action, proposal }
}

/**
 * Whether `headSha` is an ancestor of `mainSha` (SHOULD 1): ONE call to GitHub's compare endpoint, bounded by this
 * action's deadline. true when main is ahead of the head with the head as merge base; false when GitHub says otherwise;
 * null when the answer failed or is not one of those (a failed compare leaves the attempt unknown, never void).
 */
async function headIsAncestor(headSha, mainSha, env, context) {
  if (headSha === mainSha) return true
  let value
  try { value = await github(env, context.networkFetch, `/compare/${headSha}...${mainSha}`, context.signal, 8 * 1024 * 1024) } catch (_error) { return null }
  if (!record(value) || value.base_commit?.sha !== headSha || !SHA.test(value.merge_base_commit?.sha ?? '') || !['ahead', 'behind', 'diverged', 'identical'].includes(value.status)
    || !Number.isSafeInteger(value.ahead_by) || !Number.isSafeInteger(value.behind_by)) return null
  if (value.status === 'ahead' && value.behind_by === 0 && value.ahead_by > 0 && value.merge_base_commit.sha === headSha) return true
  if (value.status === 'identical') return null
  return false
}

/** What GitHub says about a durable attempt, read-only: main, her branch, the approved head's tree, and whether the head
 * is in main (asked only when main is neither the head nor the base). */
async function attemptVerification(body, env, context) {
  const mainSha = await branchHead('main', env, context)
  const branchSha = await branchHead(body.branch, env, context, true)
  const commit = await github(env, context.networkFetch, '/commits/' + body.headSha, context.signal)
  if (commit?.sha !== body.headSha || typeof commit.commit?.tree?.sha !== 'string' || !SHA.test(commit.commit.tree.sha)) fail('REPO_REF_INVALID', 502)
  const headInMain = mainSha === body.headSha ? true : mainSha === body.baseSha ? false : await headIsAncestor(body.headSha, mainSha, env, context)
  return { mainSha, branchSha, treeSha: commit.commit.tree.sha, checkedAt: context.now(), headInMain }
}

/** The durable attempt as HEAD's inspect_merge answers it, checked; null when there is none. */
async function pendingMergeAttempt(env, context) {
  let pending
  try { pending = await headProposal({ action: 'inspect_merge' }, env, context) } catch (error) {
    if (error?.code === 'REPO_MERGE_ATTEMPT_MISSING') return null
    throw error
  }
  const body = pending.mergeBody
  if (typeof pending.attemptId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(pending.attemptId)
    || !record(body) || Object.keys(body).length !== 5 || body.action !== 'merge_proposal'
    || !validProposalBranch(body.branch) || ![body.baseSha, body.headSha, body.treeSha].every(value => typeof value === 'string' && SHA.test(value))
    || body.baseSha === body.headSha || !record(pending.binding) || canonicalJson(pending.binding) !== canonicalJson(await mergeBinding(body, context))
    || !['claimed', 'marked', 'dispatched'].includes(pending.state) || !Number.isSafeInteger(pending.ageMs) || !Number.isSafeInteger(pending.reconcileAfterMs)) fail('REPO_PROPOSAL_STORAGE_FAILED', 503)
  return pending
}

/** Reconcile a durable attempt from what GitHub says (MUST 4), never by sending anything: main at the approved
 * head, or main containing it, is merged at any age; past HEAD's deadline plus margin an attempt still claimed (nothing was
 * sent) is void; a marked or dispatched one stays REPO_REF_OUTCOME_UNKNOWN, whatever its age and whatever main is, until
 * the owner releases it (release_attempt). Younger, nothing is released. */
async function reconcileAttempt(pending, env, context) {
  const verification = await attemptVerification(pending.mergeBody, env, context)
  if (context.signal.aborted) fail('BROKER_TIMEOUT', 408)
  requireOwner(env, context)
  return await headProposal({ action: 'reconcile_merge', attemptId: pending.attemptId, mergeBody: pending.mergeBody, binding: pending.binding, verification }, env, context)
}

/** Reconcile only a durable attempt using bounded provider reads; never retry publication. The held attempt (if any) and
 * EVERY release HEAD still keeps unresolved are read again (MUST 4; MUST 2: a newer attempt
 * held never hides an older release): when a released head is now in main, HEAD records it merged after release, so he is
 * never left told void about something that merged. `releasedReconciled` lists each release's answer. */
async function reconcileProposal(input, env, context) {
  requireOwner(env, context)
  exactFields(input, ['action'])
  const pending = await pendingMergeAttempt(env, context)
  if (pending) {
    const held = await reconcileAttempt(pending, env, context)
    // The held attempt's answer is the answer; the releases are read too, and a failure there only leaves them for the next read.
    let releasedReconciled
    try { releasedReconciled = (await reconcileReleasedAll(env, context)).results } catch (error) { releasedReconciled = [{ ok: false, code: typeof error?.code === 'string' ? error.code : 'REPO_RECONCILE_FAILED' }] }
    return { ...held, action: input.action, releasedReconciled }
  }
  const { releases, results, failure } = await reconcileReleasedAll(env, context)
  if (!releases.length) fail('REPO_MERGE_ATTEMPT_MISSING', 409)
  // With no attempt held: the first release that settled merged; else a failed read is said as before (never a quiet "not
  // reconciled"); else the last one read; else the newest (nothing left unresolved).
  const merged = results.find(result => result?.reconciled === true)
  if (!merged && failure) throw failure
  return { ...(merged ?? results.at(-1) ?? { ok: true, reconciled: false, released: releases.at(-1) }), action: input.action, releasedReconciled: results }
}

/** HEAD's kept releases (inspect_released), each checked; `read` is that answer when the caller already has it. */
async function keptReleases(env, context, read = null) {
  const value = read ?? await headProposal({ action: 'inspect_released' }, env, context)
  const releases = Array.isArray(value?.releases) ? value.releases : value?.released ? [value.released] : []
  for (const released of releases) {
    if (!record(released) || typeof released.attemptId !== 'string' || ![released.baseSha, released.headSha, released.treeSha].every(item => typeof item === 'string' && SHA.test(item))
      || !validProposalBranch(released.branch) || !['void-by-owner', 'merged-after-release'].includes(released.state)) fail('REPO_PROPOSAL_STORAGE_FAILED', 503)
  }
  return releases
}

/** One kept release read again from what GitHub says (only one still void-by-owner asks GitHub anything). */
async function reconcileReleased(released, env, context) {
  if (released.state !== 'void-by-owner') return { ok: true, reconciled: false, released }
  const verification = await attemptVerification(released, env, context)
  if (context.signal.aborted) fail('BROKER_TIMEOUT', 408)
  requireOwner(env, context)
  return await headProposal({ action: 'reconcile_released', attemptId: released.attemptId, verification }, env, context)
}

/** Review, MUST 2: every kept release still unresolved, read again, oldest first (at most HEAD's
 * REPO_RELEASED_MAX, so at most that many times four GitHub reads); one whose reads fail stays unresolved for the next
 * read (`failure` is the first such error), and the deadline ends the round (BROKER_TIMEOUT) with the rest unread, never
 * misread. */
async function reconcileReleasedAll(env, context) {
  const releases = await keptReleases(env, context), results = []
  let failure = null
  for (const released of releases) {
    if (released.state !== 'void-by-owner') continue
    if (context.signal.aborted) fail('BROKER_TIMEOUT', 408)
    try { results.push(await reconcileReleased(released, env, context)) } catch (error) {
      if (error?.code === 'OWNER_SESSION_REQUIRED' || context.signal.aborted) throw error
      failure ??= error
      results.push({ ok: false, attemptId: released.attemptId, code: typeof error?.code === 'string' ? error.code : 'REPO_RECONCILE_FAILED' })
    }
  }
  return { releases, results, failure }
}

/**
 * Review ("never told void about something that merged"): with no attempt held, a new merge of the very
 * merge the owner released first asks GitHub about the released one. When its head is now in main, HEAD records it merged
 * after release (the stage is cleared) and the merge answers merged, resumed, with no approval spent; otherwise null and the
 * merge goes on as before. Only for the same branch, base, head and tree, so another proposal's merge pays no extra read.
 * A released record HEAD cannot read is left alone here: it is advisory, and the merge's own reads still decide.
 */
async function mergedAfterRelease(input, env, context) {
  let releases
  try { releases = await keptReleases(env, context) } catch (_error) { return null }
  // Review, MUST 2: the kept release of this very merge, by its terms, whichever release is newest.
  const released = releases.find(item => item.state === 'void-by-owner' && ['branch', 'baseSha', 'headSha', 'treeSha'].every(key => item[key] === input[key]))
  if (!released) return null
  const result = await reconcileReleased(released, env, context)
  if (result?.reconciled !== true || result.outcome?.status !== 'succeeded' || result.outcome.commitSha !== input.headSha) return null
  return { ok: true, action: 'merge_proposal', commitSha: input.headSha, branch: input.branch, treeSha: input.treeSha, attemptId: released.attemptId, resumed: true, mergedAfterRelease: true }
}

/** What to do when GitHub shows neither the approved head in main nor anything that proves the ref update failed. */
export const RELEASE_ATTEMPT_NEXT = 'GitHub shows main neither at this merge nor containing it, and a ref update that was sent may still land: check GitHub; only when he is sure it did not land does he release the attempt with a fresh passkey (release_attempt), and a later read still says merged if it lands after all'

/** Review, MUST 2: why a release is refused when every release HEAD keeps is still unresolved. Review,
 * MUST: and the owner's way out, named in his own passkey terms. */
export const RELEASE_LIMIT_NEXT = 'every release HEAD keeps is still unresolved (GitHub has not shown it in main); a new release would forget one that may still land, so it waits until one of them shows up in main, or he releases with a fresh passkey over terms that also name the oldest one (forgets: oldest.attemptId; its head is shown), which HEAD then stops watching'
/** A kept release as HEAD names it in a refusal: its id, branch and head; anything else is dropped. */
const releaseRef = value => value !== null && typeof value === 'object' && typeof value.attemptId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.attemptId)
  && validProposalBranch(value.branch) && typeof value.headSha === 'string' && SHA.test(value.headSha) ? { attemptId: value.attemptId, branch: value.branch, headSha: value.headSha } : null

/**
 * The owner releases a held attempt (MUST 4): { action: 'release_attempt', attemptId, baseSha, headSha }, behind
 * the same owner session rule as a merge and a fresh Class 3 approval over exactly these terms, which HEAD consumes in
 * the transaction that records the attempt void-by-owner. Every read comes first: when GitHub shows the head in main the
 * attempt is settled merged instead and no approval is spent.
 */
async function releaseAttempt(input, env, context) {
  requireOwner(env, context)
  exactFields(input, ['action', 'attemptId', 'baseSha', 'headSha', 'forgets'])
  const id = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  // Review, MUST: `forgets` (optional) names the oldest kept release to drop at the bound; his passkey covers it.
  if (Object.keys(input).length !== (Object.hasOwn(input, 'forgets') ? 5 : 4) || !id(input.attemptId) || Object.hasOwn(input, 'forgets') && (!id(input.forgets) || input.forgets === input.attemptId)
    || ![input.baseSha, input.headSha].every(value => SHA.test(value)) || input.baseSha === input.headSha) fail('REPO_RELEASE_INVALID')
  const binding = await mergeBinding(input, context)
  const approvalToken = context.request?.headers.get('x-x6-class3-approval') ?? null
  const pending = await pendingMergeAttempt(env, context)
  if (!pending) fail('REPO_MERGE_ATTEMPT_MISSING', 409)
  if (pending.attemptId !== input.attemptId || pending.mergeBody.baseSha !== input.baseSha || pending.mergeBody.headSha !== input.headSha) fail('REPO_MERGE_ATTEMPT_STALE', 409)
  const verification = await attemptVerification(pending.mergeBody, env, context)
  if (context.signal.aborted) fail('BROKER_TIMEOUT', 408)
  requireOwner(env, context)
  freezeJson(input)
  return { ...await headProposal({ action: 'release_attempt', release: input, binding, verification }, env, context, { approval: approvalToken }), action: input.action }
}

/** What to do when a merge attempt ended after his approval was spent but before main could move (MUST 5). */
export const APPROVAL_SPENT_VOID_NEXT = 'his approval for this merge was spent and main did not move: stage_proposal again and ask him for a new passkey'
/** Time the steps after the reads need (attempt claimed with his approval, mark, ref update, bookkeeping). With less
 * left, the merge stops before anything is claimed or spent. */
export const MERGE_AFTER_READS_RESERVE_MS = 3000
/** Bookkeeping that settles an attempt after this call's own deadline fired gets its own short limit (HEAD only). */
const SETTLE_TIMEOUT_MS = 3000
/** How long a merge cut off by its deadline may take to settle its own attempt before the answer (one HEAD call, at most
 * SETTLE_TIMEOUT_MS, follows the cut on every path), so its answer is the truthful one, not a bare 408. */
export const MERGE_SETTLE_GRACE_MS = SETTLE_TIMEOUT_MS + 1000

/**
 * An earlier attempt meets a new merge call (MUST 3b and d). A call for ANOTHER proposal is refused. For the same
 * one, what GitHub says decides: main at the approved head, or containing it, finishes it as merged with no passkey;
 * otherwise an attempt younger than HEAD's deadline plus margin may still have its owning call running, so the answer is
 * 409 REPO_MERGE_PENDING with its age and nothing is released or spent; an older one still claimed (nothing sent) is void
 * (the call continues with its own approval, or says the earlier one was spent); a marked or dispatched one stays
 * REPO_REF_OUTCOME_UNKNOWN, with both refs and its age, until the owner releases it (MUST 4).
 * @returns {Promise<{ result: object } | { voided: true }>}
 */
async function settleEarlierAttempt(pending, input, binding, env, context) {
  const timing = { outcome: 'unknown', ageMs: pending.ageMs, reconcileAfterMs: pending.reconcileAfterMs }
  if (canonicalJson(pending.mergeBody) !== canonicalJson(input) || canonicalJson(pending.binding) !== canonicalJson(binding)) fail('REPO_MERGE_PENDING', 409, timing)
  const result = await reconcileAttempt(pending, env, context)
  if (result.reconciled === true && result.outcome?.status === 'succeeded') {
    return { result: { ok: true, action: 'merge_proposal', commitSha: input.headSha, branch: input.branch, treeSha: input.treeSha, attemptId: pending.attemptId, resumed: true } }
  }
  if (result.reconciled === true && result.outcome?.status === 'failed') return { voided: true }
  if (result.outcome?.code === 'REPO_REF_OUTCOME_UNKNOWN') fail('REPO_REF_OUTCOME_UNKNOWN', 409, { outcome: 'unknown', mainSha: result.mainSha, baseSha: input.baseSha, headSha: input.headSha,
    attemptId: pending.attemptId, held: true, ...(Number.isSafeInteger(result.ageMs) ? { ageMs: result.ageMs } : {}) })
  fail('REPO_MERGE_PENDING', 409, { ...timing, ...(Number.isSafeInteger(result.ageMs) ? { ageMs: result.ageMs } : {}) })
}

/** Settle this call's own attempt as void (its owner nonce): only ever when nothing was sent. 'void' when HEAD wrote it;
 * 'absent' when HEAD holds no attempt of this nonce (begin_merge never committed, so nothing was consumed either: the two
 * are one transaction); 'unknown' when HEAD did not answer (the attempt stays and is reconciled after the margin). */
async function voidOwnAttempt(owner, attemptId, env, context) {
  try {
    await headProposal({ action: 'merge_outcome', owner, ...(attemptId ? { attemptId } : {}), outcome: { status: 'failed', code: 'REPO_APPROVAL_SPENT_VOID' } }, env, context, { signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS) })
    return 'void'
  } catch (error) { return error?.code === 'REPO_MERGE_ATTEMPT_STALE' ? 'absent' : 'unknown' }
}

/** The facts a merge refusal carries for the card (MUST 3): an attempt's age while it is held, and both refs
 * when what GitHub says fits neither outcome. Numbers and SHAs only. */
function mergeAttemptFacts(code, error) {
  if (code === 'REPO_RELEASE_LIMIT') return { next: RELEASE_LIMIT_NEXT, ...Object.fromEntries(['limit', 'unresolved'].filter(key => Number.isSafeInteger(error?.[key])).map(key => [key, error[key]])),
    ...(releaseRef(error?.oldest) ? { oldest: releaseRef(error.oldest) } : {}) }
  if (code === 'REPO_MERGE_PENDING') return Object.fromEntries(['ageMs', 'reconcileAfterMs'].filter(key => Number.isSafeInteger(error?.[key])).map(key => [key, error[key]]))
  if (code === 'REPO_REF_OUTCOME_UNKNOWN') return { ...Object.fromEntries(['mainSha', 'baseSha', 'headSha'].filter(key => typeof error?.[key] === 'string' && SHA.test(error[key])).map(key => [key, error[key]])),
    ...(error?.held === true ? { held: true, next: RELEASE_ATTEMPT_NEXT, ...(typeof error.attemptId === 'string' && /^[0-9a-f-]{36}$/.test(error.attemptId) ? { attemptId: error.attemptId } : {}),
      ...(Number.isSafeInteger(error.ageMs) ? { ageMs: error.ageMs } : {}) } : {}) }
  return {}
}

/**
 * Merge a staged proposal into main (MUST 3 and 4). Order: an earlier attempt settled or refused -> every read
 * (fresh refs, so a moved branch is refused here; ancestry; both trees and every file, so the fence; the repository id;
 * both workflows) -> enough time left -> begin_merge, in which HEAD consumes his approval and claims the attempt in ONE
 * storage transaction, owned by this call's nonce -> the mark -> the atomic ref update (GitHub checks each ref's expected
 * old value) -> its bookkeeping. After consumption nothing but the mark, the ref update and its bookkeeping remain, and
 * every exit is settled truthfully by this call: before anything is sent, void (REPO_APPROVAL_SPENT_VOID, approve again);
 * after, unknown until GitHub says.
 */
async function mergeProposal(input, env, context) {
  requireOwner(env, context)
  exactFields(input, ['action', 'baseSha', 'branch', 'headSha', 'treeSha'])
  if (Object.keys(input).length !== 5 || !validAumaBranch(input.branch) || ![input.baseSha, input.headSha, input.treeSha].every(value => SHA.test(value))) fail('REPO_PROPOSAL_INVALID')
  const binding = await mergeBinding(input, context)
  const approvalToken = context.request?.headers.get('x-x6-class3-approval') ?? null
  const pending = await pendingMergeAttempt(env, context)
  const earlier = pending ? await settleEarlierAttempt(pending, input, binding, env, context) : null
  if (earlier?.result) return earlier.result
  // Review: a merge he released that GitHub now shows in main is merged, not a conflict and not a second spend.
  const landed = pending ? null : await mergedAfterRelease(input, env, context)
  if (landed) return landed
  if (!approvalToken) fail(earlier?.voided ? 'REPO_APPROVAL_SPENT_VOID' : 'CLASS3_WEBAUTHN_REQUIRED', earlier?.voided ? 409 : 403)
  // Every read before his approval: the fence (frozen, open, plain) is judged inside, so a refused path, a moved branch
  // or a red workflow leaves his approval unspent. The card's ciStatus is the snapshot from stage_proposal; this is now.
  await proposalEvidence(input.branch, env, context, input)
  const ciStatus = await proposalCi(input.branch, input.headSha, env, context)
  if (ciStatus !== 'passed') fail('REPO_PROPOSAL_CI_NOT_PASSED', 409, { ciStatus })
  const id = await repositoryId(env, context)
  if (context.signal.aborted || (Number.isFinite(context.deadlineAt) && Date.now() > context.deadlineAt - MERGE_AFTER_READS_RESERVE_MS)) fail('BROKER_TIMEOUT', 408)
  // His session must outlast everything this call can still do, its settling included: HEAD refuses an
  // expired session, so one that ran out after begin_merge could not even void the attempt. Refused here, nothing is spent.
  // On the owner clock requireOwner uses (context.now()); the time left to the deadline is measured on the real one.
  const left = Number.isFinite(context.deadlineAt) ? Math.max(0, context.deadlineAt - Date.now()) : CLOUD_BROKER_LIMITS.timeoutMs
  if (!Number.isFinite(context.access?.expires) || context.access.expires * 1000 <= context.now() + left + MERGE_SETTLE_GRACE_MS) fail('OWNER_SESSION_REQUIRED', 403)
  freezeJson(input)
  const owner = crypto.randomUUID()
  let begin
  try { begin = await headProposal({ action: 'begin_merge', mergeBody: input, binding, owner }, env, context, { approval: approvalToken }) } catch (error) {
    // HEAD answered with a refusal (his approval refused, another attempt held, the stage changed): its one transaction
    // wrote nothing, so nothing was consumed.
    if (error?.headAnswered === true) throw error
    // The answer was lost: the claim may have been written with this call's nonce. Nothing was sent, so it is settled void.
    const settled = await voidOwnAttempt(owner, null, env, context)
    if (settled === 'void') fail('REPO_APPROVAL_SPENT_VOID', 409)
    throw settled === 'absent' ? error : Object.assign(error, { outcome: 'unknown' })
  }
  if (typeof begin.attemptId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(begin.attemptId) || !Number.isSafeInteger(begin.approvalExpiresAt)) {
    if (await voidOwnAttempt(owner, null, env, context) === 'void') fail('REPO_APPROVAL_SPENT_VOID', 409)
    fail('REPO_PROPOSAL_STORAGE_FAILED', 503, { outcome: 'unknown' })
  }
  context.repoApprovalExpiresAt = begin.approvalExpiresAt
  try {
    await headProposal({ action: 'mark_merge', attemptId: begin.attemptId, owner }, env, context)
    await updateRefs([
      { name: 'refs/heads/main', beforeOid: input.baseSha, afterOid: input.headSha, force: false },
      { name: 'refs/heads/' + input.branch, beforeOid: input.headSha, afterOid: input.headSha, force: false },
    ], id, env, context)
    await headProposal({ action: 'merge_outcome', attemptId: begin.attemptId, owner, outcome: { status: 'succeeded', commitSha: input.headSha } }, env, context)
    return { ok: true, action: 'merge_proposal', commitSha: input.headSha, branch: input.branch, treeSha: input.treeSha }
  } catch (error) {
    if (!context.refMutationDispatched) {
      // A refusal made here before anything was sent (the mark failed or its answer was lost; the owner session or his
      // approval expired; the call was cancelled): settled void in this same call (MUST 3c).
      if (await voidOwnAttempt(owner, begin.attemptId, env, context) === 'void') fail('REPO_APPROVAL_SPENT_VOID', 409)
      throw Object.assign(error, { outcome: 'unknown' })
    }
    try {
      await headProposal({ action: 'merge_outcome', attemptId: begin.attemptId, owner, outcome: { status: 'unknown', code: 'REPO_REF_OUTCOME_UNKNOWN' } }, env, context, { signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS) })
    } catch (_storageError) { /* The attempt stays marked; a later call reconciles it from what GitHub says. */ }
    throw error
  }
}

/** Her promotion ledger, which travels with the head it records (AURA HANDOFF-3). */
export const RECEIPTS_LEDGER_PATH = 'mirror/home/auma/seed/receipts.v3.jsonl'

/**
 * Whether her mirror ledger may be published over main's copy: only as a BYTE-exact append-only extension of whole rows
 * (compare and preserve bytes, not decoded strings, so a BOM or a re-encoding cannot slip by).
 * @param {Uint8Array} mirror - her ledger's bytes as the mirror holds them.
 * @param {Uint8Array | null} main - main's verified bytes, or null when main has none (the tree says so; never on a read failure).
 * @returns {'up-to-date' | 'appended' | 'not-append-only' | 'incomplete-row'}
 */
export function receiptsAppendDecision(mirror, main) {
  const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])
  if (main !== null && same(mirror, main)) return 'up-to-date'
  // A row still being written is never published; a row main holds is never edited, not even its last byte.
  if (mirror.length > 0 && mirror[mirror.length - 1] !== 0x0a) return 'incomplete-row'
  if (main === null || main.length === 0) return 'appended'
  if (main[main.length - 1] !== 0x0a || main.length > mirror.length || !main.every((byte, i) => byte === mirror[i])) return 'not-append-only'
  return 'appended'
}

/** Git's blob id of these bytes: sha1("blob <length>\0" + bytes), the id a tree entry names. */
export async function gitBlobSha(bytes) {
  const header = encoder.encode(`blob ${bytes.length}\0`)
  const all = new Uint8Array(header.length + bytes.length)
  all.set(header, 0)
  all.set(bytes, header.length)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Main's copy of her ledger at the pinned commit, for the append-only check only. This is not a remote fallback for
 * reading her memory (remotePathAllowed stays closed to it); it reads exactly this one path. The bytes returned must hash
 * to the blob the PINNED TREE names: an answer that merely claims that sha (a truncated body, say) is refused. `null`
 * only when the complete pinned tree has no such file; any other failure throws, so nothing is published on doubt.
 */
async function mainLedgerBytes(baseTree, env, networkFetch, signal) {
  const entry = regularFile(baseTree.tree, RECEIPTS_LEDGER_PATH, true)
  if (entry === null) return null
  const value = await github(env, networkFetch, '/contents/' + encodePath(RECEIPTS_LEDGER_PATH) + '?ref=' + baseTree.commitSha, signal, CLOUD_REPO_READ_LIMITS.encodedResponseBytes)
  if (!record(value) || value.type !== 'file' || value.path !== RECEIPTS_LEDGER_PATH || value.encoding !== 'base64' || typeof value.content !== 'string'
    || value.sha !== entry.sha) fail('BROKER_CONTENT_INVALID', 502)
  const { bytes } = decodeFileBytes(value.content.replace(/\n/g, ''), env)
  if (await gitBlobSha(bytes) !== entry.sha) fail('BROKER_CONTENT_INVALID', 502)
  return bytes
}

/** Text that re-encodes to exactly these bytes (a BOM kept), or null when that cannot be guaranteed. */
function exactText(bytes) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch (_error) { return null }
  const again = encoder.encode(text)
  return again.length === bytes.length && again.every((byte, i) => byte === bytes[i]) ? text : null
}

async function repo(input, env, context) {
  const { bootstrap, networkFetch, signal } = context
  if (input.action === 'search') return await searchRepository(input, env, context)
  if (input.action === 'compare_files') return await compareFiles(input, env, context)
  if (input.action === 'stage_proposal') return await stageProposal(input, env, context)
  if (input.action === 'reconcile_proposal') return await reconcileProposal(input, env, context)
  if (input.action === 'release_attempt') return await releaseAttempt(input, env, context)
  if (input.action === 'merge_proposal') return await mergeProposal(input, env, context)
  const branch = repoRef(input.branch)
  if (['branch_create', 'branch_delete'].includes(input.action) || branch !== 'main' && ['write', 'edit', 'commit'].includes(input.action)) return await branchOperation(input, env, context)
  if (branch !== 'main' && !['read', 'diff'].includes(input.action)) fail('REPO_BRANCH_REFUSED', 403)
  if (branch === 'main' && ['write', 'edit', 'commit', 'push'].includes(input.action)) {
    const paths = ['write', 'edit'].includes(input.action) ? [input.path] : Array.isArray(input.changes) ? input.changes.map(file => file?.path) : []
    for (const path of paths) if (isT2ProtectedRepoPath(path)) refuseT2OnMain(path)
  }
  if (input.action === 'bytes') return await byteInspection(input, env, context)
  if (input.action === 'state_diff') return await stateDiff(input, env, context)
  if (input.action === 'diagnostics') {
    if (Object.keys(input).some(key => key !== 'action')) fail('BROKER_QUERY_INVALID')
    return await diagnosticsReport(env, context)
  }
  if (input.action === 'selftest') {
    if (Object.keys(input).some(key => key !== 'action')) fail('BROKER_QUERY_INVALID')
    return await selftest(env, context)
  }
  if (input.action === 'tree') {
    if (Object.keys(input).some(key => !['action', 'prefix'].includes(key))) fail('BROKER_QUERY_INVALID')
    return { ok: true, ...await repositoryTree(input.prefix, env, networkFetch, signal) }
  }
  if (input.action === 'status') {
    const meta = metadata(env)
    return { ok: true, ...meta, commitPolicy: 'owner-approved-explicit-source-v1', ...await currentState(env, bootstrap, signal), githubConfigured: typeof env.GITHUB_TOKEN === 'string' && Boolean(env.GITHUB_TOKEN), stdout: `## main\n${meta.sourceRevision}`, stderr: '' }
  }
  if (input.action === 'read') {
    exactFields(input, ['action', 'path', 'offset', 'length', 'branch', 'ownerSession'])
    const offset = input.offset === undefined ? 0 : input.offset
    const length = input.length === undefined ? undefined : input.length
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 1 || length > CLOUD_REPO_READ_LIMITS.fileBytes))) fail('REPO_BYTE_RANGE_INVALID')
    const path = requirePath(input.path)
    const sliceContent = fullResult => {
      if (input.offset === undefined && input.length === undefined) return fullResult
      const totalBytes = size(fullResult.content)
      const content = fullResult.content.slice(offset, length === undefined ? undefined : offset + length)
      const nextOffset = (length !== undefined && offset + length < fullResult.content.length) ? offset + length : null
      return { ...fullResult, content, offset, length: content.length, totalBytes, totalLength: fullResult.content.length, nextOffset, truncated: nextOffset !== null }
    }
    if (branch === 'main' && liveMirrorPath(path)) {
      const mirror = await mirrorRead(path, env, bootstrap.head.seedId, signal)
      if (mirror.kind === 'gone') fail('REPO_PATH_DELETED', 404)
      if (mirror.kind === 'dir') fail('REPO_FILE_REQUIRED', 409)
      if (mirror.kind === 'file') return sliceContent({ ok: true, path, content: decodeFile(mirror.b64, env), source: 'mirror', lineageId: mirror.lineageId, revision: mirror.revision })
      if (!remotePathAllowed(path)) fail('REPO_PRIVATE_FALLBACK_REFUSED', 404)
    }
    return sliceContent({ ok: true, path, ...await githubFile(path, env, networkFetch, signal, branch), source: branch === 'main' ? 'github-main' : 'github-branch', ...(branch === 'main' ? {} : { branch }) })
  }
  if (input.action === 'log') {
    const limit = input.limit ?? 10
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) fail('BROKER_QUERY_INVALID')
    const log = await commits(env, networkFetch, signal, limit)
    return { ok: true, commits: log, stdout: log.map(commit => `${commit.sha.slice(0, 8)} ${commit.message.split('\n')[0]}`).join('\n'), stderr: '' }
  }
  if (input.action === 'diff') {
    if (Object.keys(input).some(key => !['action', 'base', 'path', 'branch', 'ownerSession'].includes(key))) fail('BROKER_QUERY_INVALID')
    if (branch !== 'main') {
      const base = input.base ?? await branchHead('main', env, context)
      if (!SHA.test(base)) fail('REPO_BASE_SHA_REQUIRED')
      // A read: a frozen file is marked (frozen, next), never refused here; stage, merge and CI refuse it.
      if (input.path !== undefined) branchPathName(input.path, env)
      const after = await pinnedTree(branch, env, networkFetch, signal)
      await mainComparison(base, after.commitSha, env, networkFetch, signal)
      const before = await pinnedTree(base, env, networkFetch, signal)
      const changed = await inspectedChanges(before, after, env, context, true, { markFrozen: true }), files = []
      for (const file of changed) {
        if (input.path !== undefined && file.path !== input.path) continue
        const left = file.status === 'added' ? '' : (await githubFileAt(file.path, before, env, networkFetch, signal)).content
        const right = file.status === 'removed' ? '' : (await githubFileAt(file.path, after, env, networkFetch, signal)).content
        files.push({ ...file, patch: lineDiff(left, right, file.path, file.path).diff })
      }
      return { ok: true, base, head: after.commitSha, branch, files, filtered: false, truncated: false, stdout: files.map(file => file.patch).join('\n'), stderr: '' }
    }
    const diff = await comparison(input.base ?? env.SOURCE_REVISION, input.path, env, networkFetch, signal)
    return { ok: true, ...diff, stdout: diff.files.map(file => `${file.path}\n${file.patch ?? '[patch unavailable]'}`).join('\n'), stderr: '' }
  }
  const nowMs = typeof context.now === 'function' ? context.now() : Date.now()
  const ownerSessionActive = Boolean(
    (context.access?.authenticated === true && context.access?.owner === true)
    || (['owner', 'access'].includes(context.access?.type) && Number.isFinite(context.access?.expires) && context.access.expires * 1000 > nowMs),
  )
  if (ownerSessionActive && input.expectedHeadSha === undefined && input.idempotencyKey === undefined) {
    if (input.action === 'edit') {
      const path = safeText(requirePath(input.path, true), env, 1024)
      if (isT2ProtectedRepoPath(path)) refuseT2OnMain(path)
      requireDeployInertForOwnerSession(path)
      const oldString = safeText(input.oldString, env)
      const newString = safeText(input.newString, env)
      if (!oldString) fail('REPO_EDIT_TARGET_EMPTY')
      let currentContent = stagedOwnerWrites.get(path)
      if (currentContent === undefined) {
        if (liveMirrorPath(path)) {
          const mirror = await mirrorRead(path, env, bootstrap.head.seedId, signal)
          if (mirror.kind === 'file') currentContent = decodeFile(mirror.b64, env)
        }
        if (currentContent === undefined) {
          const remote = await githubFile(path, env, networkFetch, signal)
          currentContent = remote.content
        }
      }
      const firstIdx = currentContent.indexOf(oldString)
      if (firstIdx === -1) fail('REPO_EDIT_TARGET_NOT_FOUND', 409)
      if (currentContent.indexOf(oldString, firstIdx + oldString.length) !== -1) fail('REPO_EDIT_TARGET_AMBIGUOUS', 409)
      const updatedContent = currentContent.slice(0, firstIdx) + newString + currentContent.slice(firstIdx + oldString.length)
      safeText(updatedContent, env)
      if (input.dryRun === true) {
        return { ok: true, dryRun: true, tier: 'T1', action: 'edit', path, bytesWritten: size(updatedContent), staged: false }
      }
      stagedOwnerWrites.set(path, updatedContent)
      if (input.message === undefined) {
        return { ok: true, tier: 'T1', action: 'edit', path, bytesWritten: size(updatedContent), staged: true, content: updatedContent }
      }
      input = { ...input, action: 'write', path, content: updatedContent }
    }
    if (input.action === 'write' && input.message === undefined) {
      const path = safeText(requirePath(input.path, true), env, 1024), content = safeText(input.content, env)
      if (isT2ProtectedRepoPath(path)) refuseT2OnMain(path)
      requireDeployInertForOwnerSession(path)
      if (input.dryRun === true) {
        return { ok: true, dryRun: true, tier: 'T1', action: 'write', path, bytesWritten: size(content), staged: false }
      }
      stagedOwnerWrites.set(path, content)
      return { ok: true, tier: 'T1', action: 'write', path, bytesWritten: size(content), staged: true }
    }
    if (input.action === 'commit' || (input.action === 'write' && typeof input.message === 'string')) {
      const message = safeText(input.message, env, 1024)
      if (!message.trim() || /[\r\n]/.test(message)) fail('REPO_COMMIT_MESSAGE_INVALID')
      const rawChanges = Array.isArray(input.changes) && input.changes.length ? input.changes
        : typeof input.path === 'string' && typeof input.content === 'string' ? [{ path: input.path, content: input.content }]
        : [...stagedOwnerWrites.entries()].map(([path, content]) => ({ path, content }))
      if (!Array.isArray(rawChanges) || !rawChanges.length || rawChanges.length > CLOUD_BROKER_LIMITS.files) fail('REPO_EXPLICIT_CHANGES_REQUIRED')
      let bytes = 0
      const files = rawChanges.map(change => {
        if (!record(change) || Object.keys(change).some(key => !['path', 'content'].includes(key))) fail('REPO_CHANGE_INVALID')
        const path = safeText(requirePath(change.path, true), env, 1024), content = safeText(change.content, env)
        if (isT2ProtectedRepoPath(path)) refuseT2OnMain(path)
        requireDeployInertForOwnerSession(path)
        bytes += size(content)
        return Object.freeze({ path, content })
      }).sort((a, b) => a.path.localeCompare(b.path))
      if (bytes > CLOUD_BROKER_LIMITS.publicationBytes || new Set(files.map(file => file.path)).size !== files.length) fail('REPO_CHANGE_INVALID')
      if (input.dryRun === true) {
        return { ok: true, dryRun: true, tier: 'T1', action: input.action, committed: false, paths: files.map(file => file.path) }
      }
      const history = await commits(env, networkFetch, signal, 1)
      const headSha = history[0].sha
      const baseTree = await pinnedTree(headSha, env, networkFetch, signal)
      for (const file of files) regularFile(baseTree.tree, file.path, true)
      const query = 'mutation X61Publish($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }'
      const additions = files.map(file => ({ path: file.path, contents: btoa(Array.from(encoder.encode(file.content), byte => String.fromCharCode(byte)).join('')) }))
      const result = await upstream(networkFetch, 'https://api.github.com/graphql', { method: 'POST', headers: githubHeaders(env), body: JSON.stringify({ query, variables: { input: { branch: { repositoryNameWithOwner: REPOSITORY, branchName: BRANCH }, expectedHeadOid: headSha, message: { headline: message }, fileChanges: { additions } } } }) }, signal, true)
      const commit = result?.data?.createCommitOnBranch?.commit?.oid
      if (!SHA.test(commit)) fail('REPO_PUBLICATION_OUTCOME_UNKNOWN', 503)
      stagedOwnerWrites.clear()
      return { ok: true, tier: 'T1', action: input.action, branch: BRANCH, commit, commitSha: commit, headSha: commit, paths: files.map(file => file.path), stdout: commit, stderr: '' }
    }
    if (input.action === 'dispatch_workflow') {
      const workflow = typeof input.workflow === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(input.workflow) ? input.workflow : 'deploy-x61.yml'
      if (workflow !== 'deploy-x61.yml') fail('CLASS3_WEBAUTHN_REQUIRED', 403, { tier: 'T2', workflow })
      const response = await withDeadline(signal, limitedSignal => networkFetch(`https://api.github.com/repos/${REPOSITORY}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: 'POST', redirect: 'error', signal: limitedSignal, headers: githubHeaders(env), body: JSON.stringify({ ref: BRANCH }),
      }))
      if (!response.ok) fail('BROKER_UPSTREAM_FAILED', response.status === 404 ? 404 : 502)
      return { ok: true, action: 'dispatch_workflow', workflow, branch: BRANCH }
    }
    if (input.action === 'sync_head_to_github') {
      // A node's world (head, organs, hand-off note, receipts ledger) goes to the node's OWN repository. The shared source
      // repository is refused by name, whoever configured it.
      if (/\/aukora-x7$/i.test(REPOSITORY)) fail('HEAD_SYNC_SHARED_REPOSITORY', 409)
      if (!env.HEAD || context.bootstrap?.ready !== true) fail('BOOTSTRAP_REQUIRED', 503)
      const headData = await withDeadline(signal, async limitedSignal => {
        const res = await env.HEAD.get(env.HEAD.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_head/ball', {
          headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': context.bootstrap.head.seedId }, signal: limitedSignal,
        }))
        if (!res.ok) fail('HEAD_READ_FAILED', 502)
        return await boundedJson(res, 8 * 1024 * 1024, limitedSignal)
      })
      const ball = headData?.ball ?? headData?.head
      const codeBySha = record(headData?.codeBySha) ? headData.codeBySha : record(headData?.modules) ? headData.modules : {}
      if (!record(ball) || typeof ball.ballId !== 'string' || !Number.isSafeInteger(ball.epoch)) fail('HEAD_STATE_INVALID', 502)
      // A head sync copies what the edge HEAD already judged (deploy/ci/mirror-copy.mjs; CI deploys it like any other push):
      // the head must be the edge's own self-hashed manifest, and every module copied must hash to its name and be referenced by it.
      if (await headProblem(ball)) fail('HEAD_STATE_INVALID', 502)
      const referenced = referencedModules(ball)
      const verifiedCode = new Map()
      let skippedUnreferencedModules = 0
      for (const [sha, code] of Object.entries(codeBySha)) {
        if (!referenced.has(sha)) { skippedUnreferencedModules += 1; continue }
        if (typeof code !== 'string') continue
        if (await sha256Hex(code) !== sha) fail('HEAD_SYNC_MODULE_HASH_MISMATCH', 502, { module: sha })
        verifiedCode.set(sha, code)
      }
      const history = await commits(env, networkFetch, signal, 1)
      const headSha = history[0].sha
      const baseTree = await pinnedTree(headSha, env, networkFetch, signal)
      let githubHead = null
      try {
        const ghHeadFile = await githubFile('mirror/home/balls/HEAD.json', env, networkFetch, signal, headSha)
        githubHead = JSON.parse(ghHeadFile.content)
      } catch (_e) { githubHead = null }
      const pending = new Map()
      const serializedHead = serializeHead(ball)
      if (!record(githubHead) || githubHead.ballId !== ball.ballId || githubHead.epoch !== ball.epoch) {
        pending.set('mirror/home/auma/HEAD.json', serializedHead)
        pending.set('mirror/home/balls/HEAD.json', serializedHead)
      }
      for (const [sha, code] of verifiedCode) {
        const ballPath = `mirror/home/balls/${sha}.js`
        if (!baseTree.tree.entries.has(ballPath)) {
          safeText(code, env, 512 * 1024)
          pending.set(ballPath, code)
        }
      }
      for (const [entryId, entry] of Object.entries(ball.entries ?? {})) {
        if (/^[a-z][a-z0-9-]{0,63}$/.test(entryId) && typeof entry?.specifier === 'string' && entry.specifier.startsWith('ball:')) {
          const sha = entry.specifier.slice(5)
          const organPath = `mirror/home/auma/seed/organs/${entryId}.js`
          const ghSpec = githubHead?.entries?.[entryId]?.specifier
          if (verifiedCode.has(sha) && baseTree.tree.entries.has(organPath) && ghSpec !== entry.specifier) {
            safeText(verifiedCode.get(sha), env, 512 * 1024)
            pending.set(organPath, verifiedCode.get(sha))
          }
        }
      }
      // Staged candidates in her mirror (seed-pearl staging) are NOT copied: they are not referenced by the head, so they
      // are not a copy of anything judged. They reach main through a proposal card like any other change.
      let handoffContent = typeof input.handoffMarkdown === 'string' && input.handoffMarkdown.trim().length > 0
        ? safeText(input.handoffMarkdown, env, 128 * 1024)
        : null
      if (handoffContent === null && env.MIRROR) {
        try {
          const mirrorHandoff = await mirrorRead('mirror/home/auma/HANDOFF.md', env, context.bootstrap.head.seedId, signal)
          if (mirrorHandoff.kind === 'file') handoffContent = decodeFile(mirrorHandoff.b64, env)
        } catch (_e) { handoffContent = null }
      }
      if (handoffContent !== null) {
        let ghHandoff = null
        try { ghHandoff = (await githubFile('mirror/home/auma/HANDOFF.md', env, networkFetch, signal, headSha)).content } catch (_e) { ghHandoff = null }
        if (ghHandoff !== handoffContent) pending.set('mirror/home/auma/HANDOFF.md', handoffContent)
      }
      // Her promotion receipts travel with the head they record (AURA HANDOFF-3), only as an append-only extension of
      // main's copy, in the same single commit. A skipped ledger is reported (receiptsSync), never silent; nothing here
      // retries: the one createCommitOnBranch below is guarded by expectedHeadOid.
      let receiptsSync = env.MIRROR ? 'absent' : 'mirror-unavailable'
      if (env.MIRROR) {
        try {
          const mirrorReceipts = await mirrorRead(RECEIPTS_LEDGER_PATH, env, context.bootstrap.head.seedId, signal)
          if (mirrorReceipts.kind === 'file') {
            const { bytes } = decodeFileBytes(mirrorReceipts.b64, env)
            const text = exactText(bytes)
            if (text === null) receiptsSync = 'unread'
            else {
              safeText(text, env, CLOUD_REPO_READ_LIMITS.fileBytes)
              receiptsSync = receiptsAppendDecision(bytes, await mainLedgerBytes(baseTree, env, networkFetch, signal))
              // Published as text that re-encodes to the mirror's exact bytes (checked above), so nothing is stripped.
              if (receiptsSync === 'appended') pending.set(RECEIPTS_LEDGER_PATH, text)
            }
          }
        } catch (_e) { receiptsSync = 'unread' }
      }
      // The head syncs independently of her ledger (as before), but the result says exactly what happened: a ledger
      // that was skipped (unread, not append-only, an incomplete row, no mirror) is never reported as a bare synced:true.
      const ledgerSkipped = ['unread', 'not-append-only', 'incomplete-row', 'mirror-unavailable'].includes(receiptsSync)
      const ledgerFields = { synced: !ledgerSkipped, headSynced: true, ledgerSynced: !ledgerSkipped, receiptsSync,
        ...(ledgerSkipped ? { ledgerReason: receiptsSync, ledgerPath: RECEIPTS_LEDGER_PATH } : {}) }
      const files = [...pending.entries()].map(([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path))
      const recordGithubSyncTelemetry = async syncPayload => {
        try {
          await env.HEAD.get(env.HEAD.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_head/telemetry', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-x6-internal-authorized': '1',
              'x-x6-bootstrap-seed': context.bootstrap.head.seedId,
            },
            body: JSON.stringify({
              kind: 'github_sync',
              record: {
                syncedAt: (context.now ?? Date.now)(),
                epoch: ball.epoch,
                ballId: ball.ballId,
                ...syncPayload,
              },
            }),
          }))
        } catch (_e) {}
      }
      if (files.length === 0) {
        await recordGithubSyncTelemetry({ upToDate: true, headSha, commitSha: headSha, pathCount: 0, ...ledgerFields })
        return { ok: true, tier: 'T1', action: 'sync_head_to_github', upToDate: true, epoch: ball.epoch, ballId: ball.ballId, headSha, paths: [], skippedUnreferencedModules, ...ledgerFields }
      }
      for (const file of files) regularFile(baseTree.tree, file.path, true)
      // The last gate: every byte about to reach main is a verified copy of this head or one of its two records.
      const refused = await mirrorCopyRefusals(files.map(file => ({ path: file.path, bytes: encoder.encode(file.content) })), ball)
      if (refused.length) fail('HEAD_SYNC_REFUSED', 409, { refused: refused.slice(0, 16) })
      const message = `chore(x6.1): sync edge HEAD epoch ${ball.epoch} (${ball.ballId.slice(0, 8)}) to main`
      const query = 'mutation X61Publish($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }'
      const additions = files.map(file => ({ path: file.path, contents: btoa(Array.from(encoder.encode(file.content), byte => String.fromCharCode(byte)).join('')) }))
      const result = await upstream(networkFetch, 'https://api.github.com/graphql', { method: 'POST', headers: githubHeaders(env), body: JSON.stringify({ query, variables: { input: { branch: { repositoryNameWithOwner: REPOSITORY, branchName: BRANCH }, expectedHeadOid: headSha, message: { headline: message }, fileChanges: { additions } } } }) }, signal, true)
      const commit = result?.data?.createCommitOnBranch?.commit?.oid
      if (!SHA.test(commit)) fail('REPO_PUBLICATION_OUTCOME_UNKNOWN', 503)
      await recordGithubSyncTelemetry({ upToDate: false, headSha: commit, commitSha: commit, pathCount: files.length, ...ledgerFields })
      return { ok: true, tier: 'T1', action: 'sync_head_to_github', upToDate: false, epoch: ball.epoch, ballId: ball.ballId, commit, commitSha: commit, headSha: commit,
        paths: files.map(file => file.path), skippedUnreferencedModules, ...ledgerFields }
    }
  }
  if (['write', 'commit', 'push'].includes(input.action)) return await publication(input, env, context)
  fail('REPO_ACTION_UNAVAILABLE', 400)
}

async function diagnosticsReport(env, context) {
  if (context.bootstrap?.ready !== true) fail('BOOTSTRAP_REQUIRED', 503)
  const unavailable = () => ({ state: 'unavailable', code: 'DIAGNOSTICS_UNAVAILABLE' })
  const read = async (name, path, scope) => {
    if (!env[name]) return unavailable()
    try {
      return await withDeadline(context.signal, async signal => {
        const response = await env[name].get(env[name].idFromName('node-main-v1')).fetch(new Request('https://x61.internal' + path, {
          headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': context.bootstrap.head.seedId }, signal,
        }))
        if (!response.ok) { void response.body?.cancel().catch(_error => {}); return unavailable() }
        const value = await boundedJson(response, EDGE_DIAGNOSTIC_LIMITS.bytes, signal)
        if (value?.ok !== true) return unavailable()
        return { state: 'available', ...projectDiagnostics(value, scope) }
      })
    } catch (_error) { return unavailable() }
  }
  let worker
  try { worker = { state: 'available', ...projectDiagnostics(context.diagnostics(), 'worker-isolate') } }
  catch (_error) { worker = unavailable() }
  const [head, mirror] = await Promise.all([
    read('HEAD', '/_head/diagnostics', 'head-object-instance'), read('MIRROR', '/_mirror/diagnostics', 'mirror-object-instance'),
  ])
  const ok = [worker, head, mirror].every(value => value.state === 'available')
  return { ok, action: 'diagnostics', ...(!ok ? { code: 'DIAGNOSTICS_INCOMPLETE' } : {}), worker, head, mirror }
}

function actionsListQuery(url, branchAllowed = false) {
  queryParameters(url, { page: value => /^(?:[1-9]|10)$/.test(value), per_page: value => /^(?:[1-9]|[1-9][0-9]|100)$/.test(value),
    ...(branchAllowed ? { branch: value => value === 'main' || validAumaBranch(value), head_sha: value => SHA.test(value) } : {}) })
  return { page: Number(url.searchParams.get('page') ?? 1), limit: Number(url.searchParams.get('per_page') ?? 30) }
}

function projectJob(value, env, runId) {
  if (!record(value) || !Number.isSafeInteger(value.id) || value.id < 1 || value.run_id !== runId || typeof value.name !== 'string'
    || !['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(value.status)
    || !(value.conclusion === null || typeof value.conclusion === 'string') || !Array.isArray(value.steps) || value.steps.length > 1000) fail('BROKER_RESPONSE_INVALID', 502)
  const steps = value.steps.filter(step => step?.status === 'completed' && !['success', 'skipped', 'neutral'].includes(step.conclusion)).map(step => {
    if (!record(step) || !Number.isSafeInteger(step.number) || step.number < 1 || typeof step.name !== 'string' || typeof step.conclusion !== 'string') fail('BROKER_RESPONSE_INVALID', 502)
    return { number: step.number, name: safeText(step.name, env, 1000), status: 'completed', conclusion: safeText(step.conclusion, env, 40) }
  })
  return { id: value.id, name: safeText(value.name, env, 1000), status: value.status, conclusion: value.conclusion === null ? null : safeText(value.conclusion, env, 40), steps }
}

async function jobLogs(jobId, env, context) {
  return await withDeadline(context.signal, async signal => {
    let response = await context.networkFetch(`https://api.github.com/repos/${REPOSITORY}/actions/jobs/${jobId}/logs`, { method: 'GET', headers: githubHeaders(env), redirect: 'manual', signal })
    if (response.redirected) fail('BROKER_REDIRECT_REFUSED', 502)
    if (response.status === 302) {
      const location = response.headers.get('location')
      void response.body?.cancel().catch(_error => {})
      let target
      try { target = new URL(location) } catch (_error) { fail('BROKER_REDIRECT_REFUSED', 502) }
      // GitHub's signed Azure log object is fetched once without GitHub auth,
      // cookies or caller headers. No caller URL and no redirect chain is allowed.
      if (!location || location.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(location) || target.protocol !== 'https:' || target.username || target.password || target.port || target.hash
        || !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(target.hostname) || !target.searchParams.has('sig')) fail('BROKER_REDIRECT_REFUSED', 502)
      response = await context.networkFetch(target.href, { method: 'GET', headers: { accept: 'text/plain' }, redirect: 'error', signal })
    }
    if (response.redirected || response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(_error => {}); fail('BROKER_REDIRECT_REFUSED', 502) }
    if (!response.ok) { void response.body?.cancel().catch(_error => {}); fail(response.status === 404 ? 'BROKER_NOT_FOUND' : 'BROKER_UPSTREAM_FAILED', response.status === 404 ? 404 : 502) }
    const bytes = await boundedBytes(response, CLOUD_REPO_PROPOSAL_LIMITS.logBytes, signal)
    let raw
    try { raw = decoder.decode(bytes) } catch (_error) { fail('BROKER_CONTENT_INVALID', 502) }
    safeText(raw, env, CLOUD_REPO_PROPOSAL_LIMITS.logBytes)
    const clean = raw.replace(/(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[@-_])/g, '')
    safeText(clean, env, CLOUD_REPO_PROPOSAL_LIMITS.logBytes)
    const encoded = encoder.encode(clean), truncated = encoded.length > CLOUD_REPO_PROPOSAL_LIMITS.logTailBytes
    let offset = Math.max(0, encoded.length - CLOUD_REPO_PROPOSAL_LIMITS.logTailBytes)
    while (offset < encoded.length && (encoded[offset] & 0xc0) === 0x80) offset++
    return { jobId, log: decoder.decode(encoded.subarray(offset)), truncated }
  })
}

async function githubBroker(input, env, context) {
  if (input.action === 'status') {
    githubHeaders(env)
    return { ok: true, action: 'status', ...metadata(env), configured: true, readOnlyApi: false, mutations: 'exact-class3-issues-and-comments-only', stdout: 'GitHub repository broker configured; credentials remain server-side.', stderr: '' }
  }
  if (input.action !== 'api' || !['GET', 'POST'].includes(input.method ?? 'GET') || ((input.method ?? 'GET') === 'GET' && input.body !== undefined)) fail('GITHUB_API_REFUSED', 403)
  const endpoint = input.endpoint
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[\\#\s]/.test(endpoint)) fail('GITHUB_ENDPOINT_REFUSED', 403)
  const prefix = `/repos/${REPOSITORY}`, normalized = endpoint.startsWith('/') ? endpoint : '/' + endpoint
  if (normalized.split(/[/?]/).some(part => part === '.' || part === '..')) fail('GITHUB_ENDPOINT_REFUSED', 403)
  if (normalized !== prefix && !normalized.startsWith(prefix + '/') && !normalized.startsWith(prefix + '?')) fail('GITHUB_ENDPOINT_REFUSED', 403)
  const url = new URL('https://api.github.com' + normalized), suffix = url.pathname.slice(prefix.length)
  if (url.pathname + url.search !== normalized || url.search.length > 256) fail('GITHUB_ENDPOINT_REFUSED', 403)
  if (url.pathname.includes('%') || normalized.includes('%') && (suffix !== '/actions/runs' || /%(?!2[fF])/u.test(url.search))) fail('GITHUB_ENDPOINT_REFUSED', 403)
  safeText(normalized, env, 2048)
  if (input.method === 'POST') return await githubMutation(input, suffix, url, normalized, env, context)
  let result
  if (suffix === '') {
    queryParameters(url, {})
    const value = await github(env, context.networkFetch, '', context.signal)
    if (value?.full_name !== REPOSITORY || value.default_branch !== BRANCH) fail('BROKER_RESPONSE_INVALID', 502)
    result = { full_name: REPOSITORY, default_branch: BRANCH, private: value.private === true, html_url: `https://github.com/${REPOSITORY}` }
  } else if (suffix === '/commits') {
    queryParameters(url, { sha: value => value === 'main', per_page: value => /^[1-9]$|^10$/.test(value) })
    const limit = Number(url.searchParams.get('per_page') ?? 10)
    result = await commits(env, context.networkFetch, context.signal, limit)
  } else if (/^\/commits\/(?:main|[0-9a-f]{40})$/.test(suffix)) {
    queryParameters(url, {})
    const main = projectCommit(await github(env, context.networkFetch, '/commits/main', context.signal), env)
    const requested = suffix.slice('/commits/'.length)
    if (requested === 'main' || requested === main.sha) result = main
    else {
      await mainComparison(requested, main.sha, env, context.networkFetch, context.signal)
      result = projectCommit(await github(env, context.networkFetch, suffix, context.signal), env)
      if (result.sha !== requested) fail('BROKER_RESPONSE_INVALID', 502)
    }
  } else if (suffix.startsWith('/contents/')) {
    if (url.search && url.search !== '?ref=main') fail('GITHUB_ENDPOINT_REFUSED', 403)
    const path = requirePath(suffix.slice('/contents/'.length))
    result = { path, ...await githubFile(path, env, context.networkFetch, context.signal) }
  } else if (/^\/compare\/[0-9a-f]{40}\.\.\.main$/.test(suffix)) {
    queryParameters(url, {})
    const [base, head] = suffix.slice('/compare/'.length).split('...')
    result = await comparison(base, undefined, env, context.networkFetch, context.signal, head)
  } else if (suffix === '/git/trees/main') {
    if (url.search !== '?recursive=1') fail('GITHUB_ENDPOINT_REFUSED', 403)
    result = await repositoryTree(undefined, env, context.networkFetch, context.signal)
  } else if (/^\/(?:issues|pulls)$/.test(suffix)) {
    const { page, limit } = listQuery(url, true)
    const value = await github(env, context.networkFetch, suffix + url.search, context.signal)
    if (!Array.isArray(value) || value.length > limit) fail('BROKER_RESPONSE_INVALID', 502)
    result = { items: value.map(item => projectIssue(item, env, suffix === '/pulls' ? 'pull' : 'issue')), page, perPage: limit, moreMayExist: value.length === limit }
  } else if (/^\/(?:issues|pulls)\/[1-9][0-9]{0,9}$/.test(suffix)) {
    queryParameters(url, {})
    result = projectIssue(await github(env, context.networkFetch, suffix, context.signal), env, suffix.startsWith('/pulls/') ? 'pull' : 'issue')
    if (result.number !== Number(suffix.split('/')[2])) fail('BROKER_RESPONSE_INVALID', 502)
  } else if (/^\/issues\/[1-9][0-9]{0,9}\/comments$/.test(suffix)) {
    const { page, limit } = listQuery(url)
    const number = Number(suffix.split('/')[2])
    const value = await github(env, context.networkFetch, suffix + url.search, context.signal)
    if (!Array.isArray(value) || value.length > limit) fail('BROKER_RESPONSE_INVALID', 502)
    result = { items: value.map(item => projectComment(item, env, number)), page, perPage: limit, moreMayExist: value.length === limit }
  } else if (/^\/actions\/runs\/[1-9][0-9]{0,15}\/jobs$/.test(suffix)) {
    const { page, limit } = actionsListQuery(url), runId = Number(suffix.split('/')[3])
    if (!Number.isSafeInteger(runId)) fail('GITHUB_ENDPOINT_REFUSED', 403)
    const value = await github(env, context.networkFetch, suffix + url.search, context.signal, 1024 * 1024)
    if (!record(value) || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || !Array.isArray(value.jobs) || value.jobs.length > limit) fail('BROKER_RESPONSE_INVALID', 502)
    result = { totalCount: value.total_count, items: value.jobs.map(job => projectJob(job, env, runId)), page, perPage: limit, moreMayExist: page * limit < value.total_count }
  } else if (/^\/actions\/jobs\/[1-9][0-9]{0,15}\/logs$/.test(suffix)) {
    queryParameters(url, {})
    const jobId = Number(suffix.split('/')[3])
    if (!Number.isSafeInteger(jobId)) fail('GITHUB_ENDPOINT_REFUSED', 403)
    result = await jobLogs(jobId, env, context)
  } else if (suffix === '/actions/runs' || /^\/actions\/runs\/[1-9][0-9]{0,15}$/.test(suffix)) {
    if (suffix === '/actions/runs') {
      const { page, limit } = actionsListQuery(url, true)
      const value = await github(env, context.networkFetch, suffix + url.search, context.signal)
      if (!record(value) || !Array.isArray(value.workflow_runs) || value.workflow_runs.length > limit || !Number.isSafeInteger(value.total_count) || value.total_count < 0) fail('BROKER_RESPONSE_INVALID', 502)
      if (value.workflow_runs.some(item => url.searchParams.has('branch') && item.head_branch !== url.searchParams.get('branch') || url.searchParams.has('head_sha') && item.head_sha !== url.searchParams.get('head_sha'))) fail('BROKER_RESPONSE_INVALID', 502)
      result = { totalCount: value.total_count, items: value.workflow_runs.map(item => projectRun(item, env)), page, perPage: limit, moreMayExist: page * limit < value.total_count }
    } else {
      queryParameters(url, {})
      result = projectRun(await github(env, context.networkFetch, suffix, context.signal), env)
      if (String(result.id) !== suffix.split('/')[3]) fail('BROKER_RESPONSE_INVALID', 502)
    }
  } else fail('GITHUB_ENDPOINT_REFUSED', 403)
  return { ok: true, action: 'api', method: 'GET', endpoint: normalized, json: result, stdout: JSON.stringify(result), stderr: '' }
}

function queryParameters(url, allowed) {
  for (const [key, value] of url.searchParams) {
    if (!Object.hasOwn(allowed, key) || url.searchParams.getAll(key).length !== 1 || value.length > 100 || !allowed[key](value)) fail('GITHUB_ENDPOINT_REFUSED', 403)
  }
}

function listQuery(url, state = false) {
  queryParameters(url, { page: value => /^(?:[1-9]|10)$/.test(value), per_page: value => /^(?:[1-9]|[12][0-9]|30)$/.test(value),
    ...(state ? { state: value => ['open', 'closed', 'all'].includes(value) } : {}) })
  return { page: Number(url.searchParams.get('page') ?? 1), limit: Number(url.searchParams.get('per_page') ?? 30) }
}

function projectIssue(value, env, kind) {
  if (!record(value) || !Number.isSafeInteger(value.id) || value.id < 1 || !Number.isSafeInteger(value.number) || value.number < 1
    || !['open', 'closed'].includes(value.state) || typeof value.title !== 'string' || !(value.body === null || typeof value.body === 'string')
    || (Object.hasOwn(value, 'pull_request') && !record(value.pull_request))) fail('BROKER_RESPONSE_INVALID', 502)
  const type = kind === 'pull' || record(value.pull_request) ? 'pull' : 'issue'
  const url = `https://github.com/${REPOSITORY}/${type === 'pull' ? 'pull' : 'issues'}/${value.number}`
  if (value.html_url !== url) fail('BROKER_RESPONSE_INVALID', 502)
  return { id: value.id, number: value.number, kind: type, state: value.state, title: safeText(value.title, env, 1024), body: value.body === null ? null : safeText(value.body, env, 32768), url }
}

function projectComment(value, env, number) {
  if (!record(value) || !Number.isSafeInteger(value.id) || value.id < 1 || typeof value.body !== 'string') fail('BROKER_RESPONSE_INVALID', 502)
  const url = `https://github.com/${REPOSITORY}/issues/${number}#issuecomment-${value.id}`
  if (value.html_url !== url || (value.issue_url !== undefined && value.issue_url !== `https://api.github.com/repos/${REPOSITORY}/issues/${number}`)) fail('BROKER_RESPONSE_INVALID', 502)
  return { id: value.id, issueNumber: number, body: safeText(value.body, env, 32768), url }
}

function projectRun(value, env) {
  if (!record(value) || !Number.isSafeInteger(value.id) || value.id < 1 || !SHA.test(value.head_sha) || typeof value.status !== 'string'
    || !(value.conclusion === null || typeof value.conclusion === 'string') || typeof value.name !== 'string') fail('BROKER_RESPONSE_INVALID', 502)
  const url = `https://github.com/${REPOSITORY}/actions/runs/${value.id}`
  if (value.html_url !== url) fail('BROKER_RESPONSE_INVALID', 502)
  return { id: value.id, name: safeText(value.name, env, 200), headSha: value.head_sha, status: safeText(value.status, env, 40), conclusion: value.conclusion === null ? null : safeText(value.conclusion, env, 40), url }
}

async function githubMutation(input, suffix, url, endpoint, env, context) {
  const create = suffix === '/issues', comment = /^\/issues\/[1-9][0-9]{0,9}\/comments$/.test(suffix)
  if ((!create && !comment) || url.search || context.request.method !== 'POST'
    || Object.keys(input).some(key => !['action', 'method', 'endpoint', 'body'].includes(key)) || !record(input.body)
    || Object.keys(input.body).some(key => !(create ? ['title', 'body'] : ['body']).includes(key))
    || typeof input.body.body !== 'string' || !input.body.body.trim() || (create && (typeof input.body.title !== 'string' || !input.body.title.trim() || /[\r\n]/.test(input.body.title)))) fail('GITHUB_API_REFUSED', 403)
  safeText(input.body.body, env, 32768)
  if (create) safeText(input.body.title, env, 1024)
  const headers = githubHeaders(env), number = comment ? Number(suffix.split('/')[2]) : null
  freezeJson(input)
  if (typeof context.authorizeClass3 !== 'function') fail('CLASS3_WEBAUTHN_REQUIRED', 403)
  if (comment) {
    const issue = projectIssue(await github(env, context.networkFetch, '/issues/' + number, context.signal), env, 'issue')
    if (issue.number !== number || issue.kind !== 'issue') fail('GITHUB_ISSUE_TARGET_REQUIRED', 403)
  }
  const requestDigest = await sha256(canonicalJson(input)), requestUrl = new URL(context.request.url)
  const binding = { schema: 'aukora.class3.action.v1', audience: requestUrl.origin, method: context.request.method, pathname: requestUrl.pathname, bodySha256: requestDigest }
  const approval = freezeJson(structuredClone(await withDeadline(context.signal, () => context.authorizeClass3(input))))
  if (approval?.ok !== true || canonicalJson(approval.binding) !== canonicalJson(binding) || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= context.now()) fail('CLASS3_WEBAUTHN_REQUIRED', 403)
  context.signal.throwIfAborted()
  // GitHub issues/comments have no atomic idempotency key. Once dispatched, even
  // a failed content scrub can hide a completed post; only manual inspection is safe.
  context.mutationDispatched = true
  const value = await upstream(context.networkFetch, `https://api.github.com/repos/${REPOSITORY}${suffix}`, { method: 'POST', headers, body: JSON.stringify(input.body) }, context.signal)
  const result = create ? projectIssue(value, env, 'issue') : projectComment(value, env, number)
  if ((create && (result.kind !== 'issue' || result.title !== input.body.title)) || result.body !== input.body.body) fail('BROKER_RESPONSE_INVALID', 502)
  return { ok: true, action: 'api', method: 'POST', endpoint, json: result, stdout: JSON.stringify(result), stderr: '', replaySafe: false }
}

async function cloudflareBroker(input, env, context) {
  const meta = metadata(env)
  if (input.action === 'status') return { ok: true, action: 'status', worker: 'your-node', versionId: meta.buildInfo.id ?? meta.sourceRevision, ...meta, brokerConfigured: typeof env.CLOUDFLARE_API_TOKEN === 'string' && Boolean(env.CLOUDFLARE_API_TOKEN), version: meta.buildInfo.id ?? meta.sourceRevision, whoami: 'Owner-authenticated Cloudflare Worker; account credentials remain server-side.' }
  if (input.action !== 'versions') fail('CLOUDFLARE_ACTION_UNAVAILABLE', 400)
  if (input.remote !== true) return { ok: true, action: 'versions', ...meta, source: 'deployment-metadata', versions: Object.keys(meta.buildInfo).length ? [meta.buildInfo] : [{ id: meta.sourceRevision, tag: meta.sourceRevision }] }
  const token = env.CLOUDFLARE_API_TOKEN, account = env.CLOUDFLARE_ACCOUNT_ID
  if (typeof token !== 'string' || !token) fail('CLOUDFLARE_BROKER_TOKEN_UNCONFIGURED', 503)
  if (token.length > 4096 || /\s/.test(token) || typeof account !== 'string' || !/^[a-f0-9]{32}$/.test(account)) fail('CLOUDFLARE_BROKER_CONFIG_INVALID', 503)
  const value = await upstream(context.networkFetch, `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/your-node/versions`, { method: 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, context.signal)
  if (value?.success !== true || !Array.isArray(value.result?.items) || value.result.items.length > 100) fail('BROKER_RESPONSE_INVALID', 502)
  const versions = value.result.items.map(item => {
    if (!record(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(item.id)) fail('BROKER_RESPONSE_INVALID', 502)
    return { id: item.id, createdOn: typeof item.metadata?.created_on === 'string' ? safeText(item.metadata.created_on, env, 100) : null }
  })
  return { ok: true, action: 'versions', ...meta, source: 'cloudflare-api', versions }
}

/** Handle authenticated, same-origin JSON broker requests after paired bootstrap.
 * @param {Request} request Authenticated POST JSON or bodyless GET status request.
 * @param {object} env Worker bindings; secret values never appear in results.
 * @param {object} options Bootstrap metadata, fixed-target fetch, clock and trusted Class 3 consumer. The default publication approver requires its exact consumption result; null disables publication before consumption. An injected approver may additionally refuse. publicHttpsFetch must enforce public addresses at connection time through IP pinning or Cloudflare production's runtime-flag-gated public fetch, plus TLS verification, cancellation and no redirects. It is never an unguarded ambient fetch or request field. The separate trustedDocsHttpsFetch permits only its fixed provider origins; it does not establish arbitrary public-network safety. diagnostics is an optional trusted snapshot reader; absence is reported unavailable. Without either trusted transport web-eyes stays unavailable.
 * @returns {Promise<Response>} Bounded JSON with explicit refusals and unknown publication outcomes; no retries or Mac fallback. Publication retries require fresh exact Class 3 approval; owner-only reconcile_proposal reads provider state without retrying publication.
 */
export async function handleCloudBroker(request, env, { access = null, bootstrap, networkFetch, approveRepoPublication = approveConsumedRepoPublication, authorizeClass3 = null, publicHttpsFetch = null, trustedDocsHttpsFetch = null, diagnostics = null, now = Date.now }) {
  let context
  try {
    const url = new URL(request.url)
    if (url.href.includes('?') || url.href.includes('#')) fail('BROKER_QUERY_INVALID')
    if (!['/_host/repo', '/_host/github', '/_host/cloudflare', '/_host/selftest', '/_host/diagnostics', '/_host/web-eyes'].includes(url.pathname)) fail('BROKER_ROUTE_UNAVAILABLE', 404)
    if (!['GET', 'POST'].includes(request.method)) fail('METHOD_UNAVAILABLE', 405)
    if (['/_host/selftest', '/_host/diagnostics'].includes(url.pathname) && request.method !== 'GET') fail('METHOD_UNAVAILABLE', 405)
    const browserSelftest = ['/_host/selftest', '/_host/diagnostics'].includes(url.pathname) && request.method === 'GET'
    const origin = request.headers.get('origin'), referer = request.headers.get('referer')
    if ((origin !== url.origin && !(browserSelftest && origin === null)) || request.headers.get('sec-fetch-site') !== 'same-origin') fail('SAME_ORIGIN_BROWSER_REQUIRED', 403)
    if (browserSelftest && referer !== null) {
      let parsed
      try { parsed = new URL(referer) } catch (_error) { fail('SAME_ORIGIN_BROWSER_REQUIRED', 403) }
      if (parsed.origin !== url.origin || parsed.username || parsed.password) fail('SAME_ORIGIN_BROWSER_REQUIRED', 403)
    }
    if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') fail('BROKER_BODY_INVALID')
    let inputBytes = 0
    const input = request.method === 'GET' ? { action: url.pathname === '/_host/selftest' ? 'selftest' : url.pathname === '/_host/diagnostics' ? 'diagnostics' : 'status' } : await withDeadline(request.signal, signal => boundedJson(request,
      url.pathname === '/_host/repo' ? CLOUD_REPO_BRANCH_LIMITS.requestBytes : CLOUD_BROKER_LIMITS.requestBytes, signal, bytes => { inputBytes = bytes }))
    if (!record(input) || typeof input.action !== 'string') fail('BROKER_ACTION_REQUIRED')
    const privateSourceMutation = url.pathname === '/_host/repo' && validAumaBranch(input.branch) && ['write', 'edit', 'commit'].includes(input.action)
    if (!privateSourceMutation && inputBytes > CLOUD_BROKER_LIMITS.requestBytes) fail('BROKER_BODY_TOO_LARGE', 413)
    if (request.method === 'GET' && (request.body !== null || request.headers.has('transfer-encoding') || request.headers.has('content-length') && request.headers.get('content-length') !== '0')) fail('BROKER_BODY_INVALID')
    if (url.pathname === '/_host/web-eyes') return await webEyes(input, request, env, publicHttpsFetch, trustedDocsHttpsFetch, networkFetch)
    context = { access, bootstrap, networkFetch, approveRepoPublication, authorizeClass3, request, signal: request.signal, now, publicHttpsFetch, trustedDocsHttpsFetch, diagnostics, mutationDispatched: false, repoMutationDispatched: false, refMutationDispatched: false }
    const execute = async () => url.pathname === '/_host/selftest' ? await selftest(env, context)
      : url.pathname === '/_host/diagnostics' ? await diagnosticsReport(env, context)
      : url.pathname === '/_host/repo' ? await repo(input, env, context)
      : url.pathname === '/_host/github' ? await githubBroker(input, env, context)
        : await cloudflareBroker(input, env, context)
    const boundedAction = url.pathname === '/_host/repo' && (['search', 'compare_files', 'branch_create', 'branch_delete', 'stage_proposal', 'merge_proposal', 'reconcile_proposal', 'release_attempt'].includes(input.action) || input.branch !== undefined && input.branch !== 'main')
      || url.pathname === '/_host/github' && typeof input.endpoint === 'string' && input.endpoint.includes('/actions/')
    const result = boundedAction ? await withDeadline(request.signal, async signal => {
      // Share the mutation markers with the outer error handler even when its
      // deadline wins a race with a provider that ignores cancellation.
      context.signal = signal
      context.deadlineAt = Date.now() + CLOUD_BROKER_LIMITS.timeoutMs
      const value = await execute()
      if (signal.aborted) fail('BROKER_TIMEOUT', 408)
      return value
    }, { settleMs: url.pathname === '/_host/repo' && input.action === 'merge_proposal' ? MERGE_SETTLE_GRACE_MS : 0 }) : await execute()
    const serialized = JSON.stringify(result)
    const fileRead = (url.pathname === '/_host/repo' && input.action === 'read')
      || (url.pathname === '/_host/github' && typeof result.json?.content === 'string')
    const expandedRepoOutput = url.pathname === '/_host/repo' && ['compare_files', 'diff'].includes(input.action)
    const logOutput = url.pathname === '/_host/github' && typeof result.json?.log === 'string'
    const maximum = expandedRepoOutput ? 8 * 1024 * 1024 : fileRead || logOutput || privateSourceMutation ? CLOUD_REPO_READ_LIMITS.responseBytes : CLOUD_BROKER_LIMITS.responseBytes
    if (size(serialized) > maximum) fail('BROKER_BODY_TOO_LARGE', 413)
    safeText(serialized, env, maximum)
    return reply(result, result.ok === false ? 503 : 200)
  } catch (error) {
    if (context?.refMutationDispatched) return reply({ ok: false, code: 'REPO_REF_OUTCOME_UNKNOWN', outcome: 'unknown', retry: 'inspect-github-and-durable-merge-outcome-before-any-new-action', replaySafe: false, macFallback: false }, 503)
    if (context?.repoMutationDispatched) return reply({ ok: false, code: 'REPO_PUBLICATION_OUTCOME_UNKNOWN', outcome: 'unknown', retry: 'repeat-the-identical-request-to-reconcile', requiresFreshClass3Approval: true, macFallback: false }, 503)
    if (context?.mutationDispatched) return reply({ ok: false, code: 'GITHUB_MUTATION_OUTCOME_UNKNOWN', outcome: 'unknown', retry: 'inspect-github-before-new-approval', requiresFreshClass3Approval: true, replaySafe: false, macFallback: false }, 503)
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'CLOUD_BROKER_FAILED'
    return reply({ ok: false, code, macFallback: false, ...(error?.tier ? { tier: error.tier, protectedPath: error.protectedPath } : {}), ...(code === 'REPO_PROPOSAL_REQUIRED' ? { protectedPath: error.protectedPath, next: [WORKFLOW_PATH_NEXT, OWNER_MACHINE_PATH_NEXT].includes(error.next) ? error.next : DEPLOYED_PATH_NEXT } : {}), ...(code === 'REPO_PROPOSAL_CI_NOT_PASSED' && CI_STATES.includes(error.ciStatus) ? { ciStatus: error.ciStatus, next: PROPOSAL_CI_NEXT } : {}), ...(code === 'REPO_APPROVAL_SPENT_VOID' ? { next: APPROVAL_SPENT_VOID_NEXT } : {}), ...(['REPO_FROZEN_PATH_REFUSED', 'REPO_PATH_NOT_OPEN', 'REPO_PATH_NOT_PLAIN'].includes(code) && PROPOSAL_PATH_NEXTS.includes(error.next) && typeof error.protectedPath === 'string' ? { protectedPath: error.protectedPath, next: error.next } : {}), ...(error?.outcome === 'unknown' ? { outcome: 'unknown', retry: 'repeat-the-identical-request-to-reconcile', requiresFreshClass3Approval: true } : {}), ...mergeAttemptFacts(code, error) }, [400, 403, 404, 405, 408, 409, 413, 502, 503, 507].includes(error?.status) ? error.status : 503)
  }
}

/** Parse a public HTTPS hostname without resolving it; this is not a network authorization.
 * @param {string} value Absolute HTTPS URL with no credentials, fragment, literal IP or nonstandard port.
 * @returns {URL} Validated URL; the caller must still enforce public-only connections.
 */
export function publicHttpsTarget(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) fail('WEB_EYES_REQUEST_INVALID', 400)
  let target
  try { target = new URL(value) } catch (_error) { fail('WEB_EYES_URL_REFUSED', 403) }
  const hostname = target.hostname.toLowerCase().replace(/\.$/, '')
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || (target.port && target.port !== '443') || !hostname.includes('.')
    || hostname.startsWith('[') || /^\d+(?:\.\d+)*$/.test(hostname) || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(hostname)
    || hostname === 'metadata.google.internal' || hostname === 'metadata.google' || hostname === 'instance-data.ec2.internal') fail('WEB_EYES_URL_REFUSED', 403)
  if (hostname.length > 253 || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail('WEB_EYES_URL_REFUSED', 403)
  target.hostname = hostname
  return target
}

async function webEyes(input, request, env, publicHttpsFetch, trustedDocsHttpsFetch, networkFetch) {
  if (request.method !== 'POST' || !['fetch', 'search'].includes(input.action)) fail('WEB_EYES_REQUEST_INVALID', 400)
  if (input.action === 'search') {
    if (Object.keys(input).some(key => !['action', 'query', 'limit', 'maxResults'].includes(key))) fail('WEB_EYES_REQUEST_INVALID', 400)
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 512) fail('WEB_EYES_REQUEST_INVALID', 400)
    const rawLimit = input.limit ?? input.maxResults ?? 8
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 20) fail('WEB_EYES_REQUEST_INVALID', 400)
    const query = safeText(input.query.trim(), env, 512)
    if (typeof publicHttpsFetch !== 'function') return reply({ ok: false, code: 'PUBLIC_NETWORK_GUARD_UNAVAILABLE', capability: 'public-web-search', macFallback: false }, 503)
    return withDeadline(request.signal, async signal => {
      signal.throwIfAborted()
      const results = []
      const fetchJsonSource = async (apiUrl, subSignal) => {
        publicHttpsTarget(apiUrl)
        try {
          const resp = await publicHttpsFetch(apiUrl, {
            method: 'GET', redirect: 'manual', credentials: 'omit', signal: subSignal,
            headers: { accept: 'text/html, text/plain, application/json, application/xhtml+xml', 'accept-encoding': 'identity' },
          })
          if (resp.ok) {
            return JSON.parse(decoder.decode(await boundedBytes(resp, CLOUD_BROKER_LIMITS.responseBytes, subSignal)))
          }
          void resp.body?.cancel().catch(_e => {})
        } catch (err) {
          if (['WEB_EYES_CONTENT_TYPE_REFUSED', 'WEB_EYES_BODY_INVALID', 'PUBLIC_HTTPS_HEADER_INVALID'].includes(err?.code) && typeof networkFetch === 'function') {
            const fallbackResp = await networkFetch(apiUrl, {
              method: 'GET', redirect: 'manual', credentials: 'omit', signal: subSignal,
              headers: { accept: 'application/json', 'user-agent': 'Aukora-WebEyes/1.0' },
            })
            if (fallbackResp.status === 200) {
              return JSON.parse(decoder.decode(await boundedBytes(fallbackResp, CLOUD_BROKER_LIMITS.responseBytes, subSignal)))
            }
            void fallbackResp.body?.cancel().catch(_e => {})
          }
        }
        return null
      }
      try {
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=${rawLimit}&namespace=0&search=${encodeURIComponent(query)}`
        const subSignal = AbortSignal.any([signal, AbortSignal.timeout(3500)])
        const parsed = await fetchJsonSource(wikiUrl, subSignal)
        if (parsed) {
          const titles = Array.isArray(parsed?.[1]) ? parsed[1] : []
          const descs = Array.isArray(parsed?.[2]) ? parsed[2] : []
          const urls = Array.isArray(parsed?.[3]) ? parsed[3] : []
          for (let i = 0; i < titles.length && results.length < rawLimit; i++) {
            if (typeof urls[i] === 'string' && urls[i].startsWith('https://') && typeof titles[i] === 'string') {
              results.push({ title: safeText(titles[i], env, 512), url: safeText(urls[i], env, 2048), snippet: safeText(String(descs[i] || ''), env, 1024), source: 'wikipedia' })
            }
          }
        }
      } catch (_e) {}
      if (results.length < rawLimit) {
        try {
          const hnUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${rawLimit}`
          const subSignal = AbortSignal.any([signal, AbortSignal.timeout(3500)])
          const parsed = await fetchJsonSource(hnUrl, subSignal)
          if (parsed) {
            const hits = Array.isArray(parsed?.hits) ? parsed.hits : []
            for (const hit of hits) {
              if (results.length >= rawLimit) break
              const url = typeof hit?.url === 'string' && hit.url.startsWith('https://') ? hit.url : typeof hit?.objectID === 'string' ? `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}` : null
              const title = typeof hit?.title === 'string' && hit.title.trim() ? hit.title.trim() : null
              if (url && title) {
                results.push({ title: safeText(title, env, 512), url: safeText(url, env, 2048), snippet: safeText(String(hit.story_text || hit.comment_text || `Points: ${hit.points ?? 0} · Author: ${hit.author ?? 'unknown'}`).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), env, 1024), source: 'hn-algolia' })
              }
            }
          }
        } catch (_e) {}
      }
      if (results.length < rawLimit) {
        try {
          const mdnUrl = `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(query)}&locale=en-US`
          const subSignal = AbortSignal.any([signal, AbortSignal.timeout(3500)])
          const parsed = await fetchJsonSource(mdnUrl, subSignal)
          const docs = Array.isArray(parsed?.documents) ? parsed.documents : []
          for (const doc of docs) {
            if (results.length >= rawLimit) break
            const slug = typeof doc?.mdn_url === 'string' && doc.mdn_url.startsWith('/') ? `https://developer.mozilla.org${doc.mdn_url}` : null
            const title = typeof doc?.title === 'string' && doc.title.trim() ? doc.title.trim() : null
            if (slug && title) {
              results.push({ title: safeText(title, env, 512), url: safeText(slug, env, 2048), snippet: safeText(String(doc.summary || '').replace(/\s+/g, ' ').trim(), env, 1024), source: 'mdn' })
            }
          }
        } catch (_e) {}
      }
      const out = { ok: true, action: 'search', capability: 'public-web-search', query, count: results.length, results, macFallback: false }
      const serialized = JSON.stringify(out)
      if (size(serialized) > CLOUD_BROKER_LIMITS.responseBytes) fail('BROKER_BODY_TOO_LARGE', 413)
      safeText(serialized, env, CLOUD_BROKER_LIMITS.responseBytes)
      return reply(out)
    })
  }
  if (Object.keys(input).some(key => !['action', 'url', 'maxLength', 'format'].includes(key))) fail('WEB_EYES_REQUEST_INVALID', 400)
  const maxLength = input.maxLength
  if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > CLOUD_BROKER_LIMITS.responseBytes)) fail('WEB_EYES_REQUEST_INVALID', 400)
  if (input.format !== undefined && input.format !== 'text' && input.format !== 'raw') fail('WEB_EYES_REQUEST_INVALID', 400)
  const target = publicHttpsTarget(input.url)
  let decoded = input.url
  for (let index = 0; index < 4; index++) {
    safeText(decoded, env, 4096)
    let next
    try { next = decodeURIComponent(decoded) } catch (_error) { fail('WEB_EYES_URL_REFUSED', 403) }
    if (next === decoded) break
    if (index === 3) fail('WEB_EYES_URL_REFUSED', 403)
    decoded = next
  }
  safeText(target.href, env, 4096)
  for (const key of target.searchParams.keys()) if (/(?:token|key|secret|password|auth|code|session|signature|credential|jwt|bearer)/i.test(key)) fail('WEB_EYES_URL_REFUSED', 403)
  // The public adapter owns connection-time address enforcement. Cloudflare's
  // production adapter uses runtime-gated platform routing, not DNS preflight or
  // application IP pinning. Fixed docs remain a distinct fallback capability.
  const transport = typeof publicHttpsFetch === 'function' ? publicHttpsFetch : trustedDocsHttpsFetch
  const capability = typeof publicHttpsFetch === 'function' ? 'public-web-fetch' : 'trusted-docs-fetch'
  if (typeof transport !== 'function') return reply({ ok: false, code: 'PUBLIC_NETWORK_GUARD_UNAVAILABLE', capability: 'public-web-fetch', macFallback: false }, 503)
  return withDeadline(request.signal, async signal => {
    signal.throwIfAborted()
    const response = await transport(capability === 'trusted-docs-fetch' ? input.url : target.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal,
      headers: { accept: 'text/html, text/plain, text/markdown, application/json, application/xhtml+xml', 'accept-encoding': 'identity' } })
    try {
      if (response.redirected || (response.status >= 300 && response.status < 400)) fail('WEB_EYES_REDIRECT_REFUSED', 502)
      if (!response.ok) fail('WEB_EYES_UPSTREAM_FAILED', 502)
      const contentType = response.headers.get('content-type') || ''
      if (!/^(?:text\/(?:plain|html|markdown|x-markdown)|application\/(?:json|xhtml\+xml))(?:\s*;|$)/i.test(contentType)
        || (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')) fail('WEB_EYES_CONTENT_TYPE_REFUSED', 502)
      const bytes = await boundedBytes(response, CLOUD_BROKER_LIMITS.responseBytes, signal)
      let content
      try { content = decoder.decode(bytes) } catch (_error) { fail('WEB_EYES_ENCODING_INVALID', 502) }
      safeText(content, env, CLOUD_BROKER_LIMITS.responseBytes)
      if (input.format === 'text' || (input.format !== 'raw' && /^text\/html\b/i.test(contentType) && /<(?:!doctype|html|head|body|script|style)\b/i.test(content))) {
        content = content
          .replace(/<!--[\s\S]*?-->/g, ' ')
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
          .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
          .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
          .replace(/<(h[1-6]|p|div|section|article|main|header|footer|li|tr|br|pre|code|blockquote)\b[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n+/g, '\n\n')
          .trim()
      }
      if (maxLength !== undefined && content.length > maxLength) content = content.slice(0, maxLength)
      const networkPolicy = capability === 'trusted-docs-fetch' ? 'trusted-origin-allowlist'
        : transport.networkPolicy === 'cloudflare-global-fetch-strictly-public' ? transport.networkPolicy : 'injected-public-transport'
      const result = { ok: true, action: 'fetch', capability, networkPolicy, url: target.href, status: response.status, contentType, content, bytes: bytes.length, macFallback: false }
      const serialized = JSON.stringify(result)
      if (size(serialized) > CLOUD_BROKER_LIMITS.responseBytes) fail('BROKER_BODY_TOO_LARGE', 413)
      safeText(serialized, env, CLOUD_BROKER_LIMITS.responseBytes)
      return reply(result)
    } finally { if (!response.bodyUsed) void response.body?.cancel().catch(_error => {}) }
  })
}

/** The repository reads the cloud wake may make with every tab closed. Never a write, branch or proposal. */
export const CLOUD_WAKE_REPO_ACTIONS = Object.freeze({
  read: Object.freeze(['action', 'path', 'offset', 'length']),
  search: Object.freeze(['action', 'query', 'prefix', 'maxMatches']),
  log: Object.freeze(['action', 'limit']),
})

/**
 * Read-only repository access for HEAD's cloud wake, called inside the Durable Object rather than through a browser
 * request. Only `read`, `search` and `log` on `main` pass, with exactly their fields; everything goes through the same
 * `repo()` path the owner broker uses, so path allowlists, private-path refusals, secret scrubbing and deadlines all
 * apply. Never throws: a refusal is `{ ok: false, code }`.
 * @param {object} input One read request.
 * @param {object} env Worker env (GITHUB_TOKEN, MIRROR binding); never echoed.
 * @param {{ seedId: string, networkFetch?: typeof fetch, signal?: AbortSignal }} context
 * @returns {Promise<object>} The broker's own result, or a refusal code.
 */
export async function cloudWakeRepoRead(input, env, { seedId, networkFetch = globalThis.fetch, signal, screenFile } = {}) {
  try {
    if (!record(input) || typeof input.action !== 'string' || !Object.hasOwn(CLOUD_WAKE_REPO_ACTIONS, input.action)) fail('CLOUD_WAKE_REPO_ACTION_REFUSED', 403)
    exactFields(input, CLOUD_WAKE_REPO_ACTIONS[input.action])
    if (typeof seedId !== 'string' || !/^[0-9a-f]{64}$/.test(seedId)) fail('CLOUD_WAKE_REPO_UNSEEDED', 503)
    if (input.action === 'search' && typeof screenFile !== 'function') fail('CLOUD_WAKE_SCREEN_REQUIRED', 400)
    const context = { access: null, bootstrap: { head: { seedId } }, networkFetch, signal, now: Date.now,
      mutationDispatched: false, repoMutationDispatched: false, refMutationDispatched: false,
      ...(typeof screenFile === 'function' ? { screenFile } : {}) }
    const result = await withDeadline(signal, async limited => await repo(input, env, { ...context, signal: limited }))
    const serialized = JSON.stringify(result)
    if (size(serialized) > CLOUD_REPO_READ_LIMITS.responseBytes) fail('BROKER_BODY_TOO_LARGE', 413)
    safeText(serialized, env, CLOUD_REPO_READ_LIMITS.responseBytes)
    return result
  } catch (error) {
    return { ok: false, code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'CLOUD_BROKER_FAILED' }
  }
}
