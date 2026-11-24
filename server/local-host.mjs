#!/usr/bin/env node
/**
 * AUKORA — Hardened Local Host Server, AumaHead Durable-Object Emulator,
 * Live Repo Mirror, Exteroceptive Eyes, and Vault Door.
 *
 * Security invariants:
 * 1. Credentials never live in the repo or VFS mirror; they live in
 *    `~/.aukora-x6-vault/credentials.yaml` (mode 0600) and are injected
 *    exclusively at the `/door/<provider>/*` boundary.
 * 2. Zero wildcard CORS (`Access-Control-Allow-Origin: *` removed). Strict `Host` and `Origin`
 *    validation rejects cross-origin browser requests and DNS-rebinding attempts with HTTP 403.
 * 3. Every `/_host/*`, `/_mirror/*`, `/_head/*`, `/api/*`, `/door/*`, `/download/*` route and
 *    `/_head/ws` WebSocket upgrade requires the per-session capability token (`__x6_cap` HttpOnly
 *    SameSite=Strict cookie or `x-x6-capability` header stored at
 *    `~/.aukora-x6-vault/session.cap` mode 0600).
 * 4. Arbitrary relay fetches are disabled until a public-only transport is installed.
 *    Only exact read-only local probes and fixed-target search remain, without redirects.
 */
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createBallHeadStore } from './ball-head.mjs'
import { createMirrorPublisher, atomicMirrorWrite } from './mirror-store.mjs'
import { createMemoryHistory } from './memory-history.mjs'
import { createAssetCache, immutablePath } from './asset-cache.mjs'
import { createRuntimeHead } from './runtime-head.mjs'
import { createHostLifecycle } from './host-lifecycle.mjs'
import { createLocalOwnerGrantHandler } from './owner-grant.mjs'
import { createLocalEnrollmentPolicy } from './local-enrollment.mjs'
import { createLocalMessagesStorage, createLocalMessagesRequestHandler, readLocalPredictionStatus, readLocalAuraInputs, createLocalWakeStorage, createLocalWakeScheduler, createLocalWakeRequestHandler, createLocalLiveUpdates, broadcastLocalUpdate, authorizeLocalHeadWebSocket } from './messages-store.mjs'
import { projectVerifiedFacts } from './verified-facts.mjs'
import { createAumlokStore, AUMLOK_STORAGE_KEY, AUMLOK_LIMITS, aumlokRequestAction, aumlokFailureResult } from '../deploy/cloudflare/src/aumlok.mjs'
import { validateManifest, checkpointPolicyView } from '../deploy/cloudflare/src/head-do.mjs'
import { classifyHeadTransition, planLocalBrokerAction, planLocalRuntimeAction } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { MODEL_HOST_POLICY, readModelRepositoryStatus, readModelSourceFile } from '../deploy/cloudflare/src/model-host-policy.mjs'
import { providerBudgetLimits, providerRequestReservation, providerBudgetRecordStorage, reserveProviderBudget } from '../deploy/cloudflare/src/provider-budget.mjs'
import { secretShapedPart } from '../deploy/cloudflare/src/mirror-secret-paths.mjs'

const execFileAsync = promisify(execFile)
process.env.PATH = `${os.homedir()}/.local/bin:${os.homedir()}/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const DIST_DIR = path.join(REPO_ROOT, 'apps', 'web', 'dist')
const MIRROR_DIR = path.join(REPO_ROOT, 'mirror')
const MIRROR_BALLS_DIR = path.join(MIRROR_DIR, 'balls')
const MIRROR_HOME_DIR = path.join(MIRROR_DIR, 'home')
const MIRROR_WORKSPACE_DIR = path.join(MIRROR_DIR, 'workspace')
// Private transport state is not part of mirror publication or browser VFS snapshots.
const messagesStorage = createLocalMessagesStorage({ directory: path.join(MIRROR_DIR, '.transport', 'messages') })
const memoryHistory = createMemoryHistory({ mirrorDirectory: MIRROR_DIR })
const assetCache = createAssetCache({ repository: REPO_ROOT, dist: DIST_DIR, maxBytes: Number(process.env.X6_ASSET_CACHE_MAX_BYTES ?? 268435456) })
const runtimeHead = createRuntimeHead({ repository: REPO_ROOT, directory: path.join(assetCache.directory, 'runtime-head'), verifyRelease: id => assetCache.verifyRuntime(id) })

async function previewBuildGate() {
  const locked = Boolean(await fsp.lstat(path.join(REPO_ROOT, '.cache', 'x61-preview-build.lock')).catch(error => { if (error.code === 'ENOENT') return null; throw error }))
  const handle = await fsp.open(path.join(REPO_ROOT, '.cache', 'x61-preview-generation.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!handle) return { locked, blocked: locked, phase: locked ? 'unknown' : 'legacy', signature: 'legacy' }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid() || (stat.mode & 0o077)) return { locked, blocked: true, phase: 'invalid', signature: 'invalid' }
    const bytes = await handle.readFile()
    let state
    try { state = JSON.parse(bytes.toString('utf8')) } catch { return { locked, blocked: true, phase: 'invalid', signature: 'invalid' } }
    if (state?.version !== 1 || typeof state.id !== 'string' || !/^[a-f0-9-]{36}$/.test(state.id) || !['building', 'complete', 'failed', 'interrupted'].includes(state.phase)) return { locked, blocked: true, phase: 'invalid', signature: 'invalid' }
    return { locked, blocked: locked || state.phase !== 'complete', phase: state.phase, signature: crypto.createHash('sha256').update(bytes).digest('hex') }
  } finally { await handle.close() }
}

const ballHeadStore = createBallHeadStore({ ballsDir: MIRROR_BALLS_DIR, homeBallsDir: path.join(MIRROR_HOME_DIR, 'balls') })
// No trusted out-of-band approval provider is installed. Browser capability and headers are not consent.
const handleLocalOwnerGrant = createLocalOwnerGrantHandler({ readHead: () => ballHeadStore.read() })

const VAULT_DIR = path.join(os.homedir(), '.aukora-x6-vault')
const VAULT_CREDENTIALS_PATH = path.join(VAULT_DIR, 'credentials.yaml')
const VAULT_CAP_PATH = path.join(VAULT_DIR, 'session.cap')

const PORT = Number(process.env.PORT ?? 4610)
const HOST = process.env.HOST ?? '127.0.0.1'
// A second host (a KeepAlive supervisor racing a manual start) exits before it writes the vault, history, wakes or asset cache.
await new Promise((resolve, reject) => {
  const probe = net.createServer().once('error', reject)
  probe.listen({ port: PORT, host: HOST, exclusive: true }, () => { probe.close(resolve) })
}).catch((error) => {
  console.error(`[x6.1-local-host] ${HOST}:${PORT} unavailable (${error.code ?? error.message}); exiting before touching shared state`)
  process.exit(1)
})

const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  '127.0.0.1',
  'localhost',
])
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
])
// Dedicated private state, never part of the VFS mirror. The existing adapter owns
// atomic files/locks; its fixed key is translated rather than widening its path access.
const aumlokStorage = createLocalMessagesStorage({ directory: path.join(MIRROR_DIR, '.transport', 'aumlok') })
const localEnrollment = createLocalEnrollmentPolicy({ origin: process.env.X6_AUMLOK_ORIGIN,
  ownerEmail: process.env.X6_OWNER_EMAIL, ownerPublicKeyHex: process.env.X6_OWNER_PUBLIC_KEY_HEX,
  mode: process.env.X6_AUMLOK_ENROLLMENT_MODE }, ALLOWED_ORIGINS)
const localAumlok = createAumlokStore({ transaction: operation => aumlokStorage.transaction(tx => operation({
  get: key => { if (key !== AUMLOK_STORAGE_KEY) throw new Error('AUMLOK_STORAGE_KEY_INVALID'); return tx.get('messages:v1') },
  put: (key, value) => { if (key !== AUMLOK_STORAGE_KEY) throw new Error('AUMLOK_STORAGE_KEY_INVALID'); return tx.put('messages:v1', value) },
})) }, { origins: [...ALLOWED_ORIGINS], ownerPublicKeyHex: process.env.X6_OWNER_PUBLIC_KEY_HEX,
  authorizeEnrollment: localEnrollment.authorizeEnrollment })
// Private, lock-protected reservations persist across host restarts and are never
// mirror publication input. Constructors do not read or create runtime files.
const localProviderBudget = providerBudgetRecordStorage(createLocalMessagesStorage({ directory: path.join(MIRROR_DIR, '.transport', 'provider-budget') }), 'messages:v1')

async function localHeadMetadata() {
  const head = await ballHeadStore.read()
  const { lease } = await ballHeadStore.inspectLease()
  return { ok: true, ballId: head?.ballId ?? null, epoch: head?.epoch ?? -1, lease }
}

// All HTTP and WebSocket callers share this refusal. No trusted host Pearl or
// owner-transition verifier is installed; a browser's flags cannot substitute.
async function publishQualifiedLocalHead(input) {
  const invalid = await validateManifest(input?.ball)
  if (invalid) return { ok: false, code: invalid, status: 400 }
  const head = await ballHeadStore.read(), ball = input.ball
  if (head?.ballId === ball.ballId) return { ok: true, ballId: head.ballId, epoch: head.epoch, idempotent: true }
  if (classifyHeadTransition(head, ball).class === 3) return { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 }
  return { ok: false, code: 'PEARL_QUALIFICATION_UNVERIFIABLE', status: 403 }
}

// Resolve `ws` from workspace node_modules
const requireFromWeb = createRequire(path.join(REPO_ROOT, 'apps', 'web', 'package.json'))
const { WebSocketServer } = requireFromWeb('ws')

await fsp.mkdir(MIRROR_BALLS_DIR, { recursive: true })
await fsp.mkdir(path.join(MIRROR_HOME_DIR, 'balls'), { recursive: true })
await fsp.mkdir(MIRROR_WORKSPACE_DIR, { recursive: true })
await fsp.mkdir(VAULT_DIR, { recursive: true, mode: 0o700 })
await fsp.chmod(VAULT_DIR, 0o700).catch(() => {})

// Initialize or load per-session capability token (`0600`)
let SESSION_CAP = process.env.X6_SESSION_CAP?.trim() || ''
if (!SESSION_CAP) {
  try {
    const existing = (await fsp.readFile(VAULT_CAP_PATH, 'utf8')).trim()
    if (existing.length >= 32) SESSION_CAP = existing
  } catch {}
}
if (!SESSION_CAP) {
  SESSION_CAP = crypto.randomBytes(32).toString('hex')
}
await fsp.writeFile(VAULT_CAP_PATH, `${SESSION_CAP}\n`, { mode: 0o600 })
await fsp.chmod(VAULT_CAP_PATH, 0o600).catch(() => {})

/** Load secret API keys from `~/.aukora-x6-vault/credentials.yaml` (`0600`). */
async function loadVaultSecrets() {
  const secrets = {
    deepseek: process.env.DEEPSEEK_API_KEY || '',
    moonshot: process.env.MOONSHOT_API_KEY || '',
    'moonshot-cn': process.env.MOONSHOT_CN_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    xai: process.env.XAI_API_KEY || '',
  }
  try {
    const raw = await fsp.readFile(VAULT_CREDENTIALS_PATH, 'utf8')
    const envKeyMap = {
      DEEPSEEK_API_KEY: 'deepseek',
      MOONSHOT_API_KEY: 'moonshot',
      MOONSHOT_CN_API_KEY: 'moonshot-cn',
      OPENROUTER_API_KEY: 'openrouter',
      OPENAI_API_KEY: 'openai',
      ANTHROPIC_API_KEY: 'anthropic',
      XAI_API_KEY: 'xai',
    }
    for (const line of raw.split(/\r?\n/)) {
      // Match `refs:` entries like `DEEPSEEK_API_KEY: sk-...`
      const refMatch = line.match(/^\s*(DEEPSEEK_API_KEY|MOONSHOT_API_KEY|MOONSHOT_CN_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY)\s*:\s*(\S+)\s*$/)
      if (refMatch) {
        const [, envKey, val] = refMatch
        const cleanVal = val.replace(/^['"]|['"]$/g, '')
        const slot = envKeyMap[envKey]
        if (slot && cleanVal && !cleanVal.startsWith('x6-vault-') && !cleanVal.startsWith('x5-')) {
          if (!secrets[slot]) secrets[slot] = cleanVal
        }
        continue
      }
      // Match `<provider>/default: sk-...` or `<provider>/apiKey: sk-...`
      const m = line.match(/^\s*([a-zA-Z0-9_-]+)\/(?:default|apiKey):\s*(\S+)\s*$/)
      if (m) {
        const [, providerKey, val] = m
        const cleanVal = val.replace(/^['"]|['"]$/g, '')
        if (cleanVal && !cleanVal.startsWith('x6-vault-') && !cleanVal.startsWith('x5-')) {
          if (providerKey.startsWith('deepseek') && !secrets.deepseek) secrets.deepseek = cleanVal
          if (providerKey === 'moonshot' && !secrets.moonshot) secrets.moonshot = cleanVal
          if (providerKey === 'openrouter' && !secrets.openrouter) secrets.openrouter = cleanVal
          if (providerKey === 'openai' && !secrets.openai) secrets.openai = cleanVal
          if (providerKey === 'anthropic' && !secrets.anthropic) secrets.anthropic = cleanVal
          if (providerKey === 'xai' && !secrets.xai) secrets.xai = cleanVal
        }
      }
    }
  } catch {}
  return secrets
}

function parseCookies(cookieHeader) {
  const out = {}
  if (typeof cookieHeader !== 'string' || !cookieHeader) return out
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function verifyHostAndOrigin(req) {
  const host = String(req.headers.host ?? '').trim().toLowerCase()
  if (host && !ALLOWED_HOSTS.has(host)) {
    return { ok: false, reason: `Disallowed Host header: ${host}` }
  }
  const origin = req.headers.origin ? String(req.headers.origin).trim() : ''
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return { ok: false, reason: `Disallowed Origin header: ${origin}` }
  }
  const secFetchSite = req.headers['sec-fetch-site'] ? String(req.headers['sec-fetch-site']).trim() : ''
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { ok: false, reason: `Disallowed Sec-Fetch-Site: ${secFetchSite}` }
  }
  return { ok: true }
}

function verifyCapability(req, urlObj) {
  const hostOriginCheck = verifyHostAndOrigin(req)
  if (!hostOriginCheck.ok) return hostOriginCheck

  const headerCap = req.headers['x-x6-capability'] ? String(req.headers['x-x6-capability']).trim() : ''
  if (headerCap && timingSafeEqualStr(headerCap, SESSION_CAP)) {
    return { ok: true }
  }
  const cookies = parseCookies(req.headers.cookie)
  if (cookies.__x6_cap && timingSafeEqualStr(cookies.__x6_cap, SESSION_CAP)) {
    return { ok: true }
  }
  const queryCap = urlObj?.searchParams?.get('cap') ?? ''
  if (queryCap && timingSafeEqualStr(queryCap, SESSION_CAP)) {
    return { ok: true }
  }
  // Allow already-open same-origin browser tab/worker requests where the browser engine sets
  // forbidden headers `Sec-Fetch-Site: same-origin` + matching `Origin` or `Referer`
  const secFetchSite = req.headers['sec-fetch-site'] ? String(req.headers['sec-fetch-site']).trim() : ''
  const referer = req.headers.referer ? String(req.headers.referer).trim() : ''
  const origin = req.headers.origin ? String(req.headers.origin).trim() : ''
  let sameOriginReferer = false
  if (referer) {
    try {
      sameOriginReferer = ALLOWED_ORIGINS.has(new URL(referer).origin)
    } catch {}
  }
  if (secFetchSite === 'same-origin' && (ALLOWED_ORIGINS.has(origin) || sameOriginReferer)) {
    return { ok: true, issueCookie: true }
  }
  return { ok: false, reason: 'Missing or invalid session capability token (__x6_cap cookie or x-x6-capability header)' }
}

/** Project selected metadata and independently read aura evidence; neither establishes runtime health. */
async function localMessagesStatus() {
  let head = null
  let headError = null
  let lease = null
  try {
    const selected = await ballHeadStore.read()
    if (selected) head = { ballId: selected.ballId, epoch: selected.epoch, organCount: Object.keys(selected.entries).length }
    else headError = 'SELECTED_HEAD_ABSENT'
    const inspected = await ballHeadStore.inspectLease()
    lease = { active: inspected.lease !== null }
  } catch (error) { headError = 'SELECTED_HEAD_UNAVAILABLE' }
  const wake = await localWake.status()
  const { aura, auraShadow, auraFocusCell } = await readLocalAuraInputs({ mirrorDirectory: MIRROR_DIR, head, wake: Object.freeze(wake) })
  return { ok: true, runtime: 'local', head, headError, lease, aura, auraShadow, auraFocusCell, prediction: await readLocalPredictionStatus({ mirrorDirectory: MIRROR_DIR }), selectionIsNotHealthProof: true }
}

const localWake = createLocalWakeScheduler({
  storage: createLocalWakeStorage({ directory: path.join(MIRROR_DIR, '.transport', 'wake') }),
  readHead: () => ballHeadStore.read(),
  readAuraInputs: input => readLocalAuraInputs({ ...input, mirrorDirectory: MIRROR_DIR }),
  onUpdated: wake => localLiveUpdates.wakeUpdated(wake),
})
const handleLocalWakeRequest = createLocalWakeRequestHandler({
  wake: localWake, sessionCapability: SESSION_CAP, allowedOrigins: ALLOWED_ORIGINS, verifyHostAndOrigin,
})

const handleLocalMessagesRequest = createLocalMessagesRequestHandler({
  storage: messagesStorage, sessionCapability: SESSION_CAP, allowedOrigins: ALLOWED_ORIGINS,
  verifyHostAndOrigin, readStatus: localMessagesStatus, readWake: () => localWake.status(),
  readFacts: async () => {
    const controller = new AbortController()
    let timer
    const operation = async () => {
      const wake = await localWake.status()
      const input = await readLocalAuraInputs({ mirrorDirectory: MIRROR_DIR, wake, signal: controller.signal, includeFacts: true,
        checkpointSignerPin: process.env.CHECKPOINT_SIGNER_PIN, checkpointSignerPolicy: process.env.CHECKPOINT_SIGNER_POLICY })
      if (JSON.stringify(wake) !== JSON.stringify(await localWake.status()) || controller.signal.aborted) return projectVerifiedFacts('local', null)
      let aumlokStatus = null
      try { aumlokStatus = await localAumlok.status() } catch (_error) { /* Identity errors do not discard independently verified core facts. */ }
      return projectVerifiedFacts('local', input, { aumlokStatus })
    }
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(projectVerifiedFacts('local', null)) }, 4000)
    })
    try { return await Promise.race([operation(), deadline]) }
    finally { clearTimeout(timer) }
  },
})

/** Only fixed local read-only probes are enabled until a pinned public transport exists. */
function validateRelayTargetUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, error: `Invalid URL: ${rawUrl}` }
  }
  // Allow safe self-status probe on local mirror and head status
  if (
    parsed.protocol === 'http:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
    String(parsed.port || '80') === String(PORT) &&
    (parsed.pathname === '/_mirror/status' || parsed.pathname === '/_head/ball' || parsed.pathname === '/_head/runtime')
  ) {
    return { ok: true, url: `http://127.0.0.1:${PORT}${parsed.pathname}`, isLocalStatusProbe: true }
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443')) {
    return { ok: false, error: `Disallowed URL protocol "${parsed.protocol}" (only public https:// allowed)` }
  }
  const host = parsed.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    return { ok: false, error: `Refused private/loopback/metadata destination host: ${host}` }
  }
  // A hostname preflight does not pin the address used by native fetch. Do not
  // expose local networking through caller-selected public-looking hostnames.
  return { ok: false, status: 503, code: 'PUBLIC_NETWORK_GUARD_UNAVAILABLE', error: 'Public network destination verification is unavailable' }
}

/** Bound complete relay bodies, including decoded/chunked content, before replying. */
async function boundedRelayBytes(response, limit = 256 * 1024) {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  let bytes = 0
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) {
        void reader.cancel().catch(_error => {})
        throw Object.assign(new Error('RELAY_RESPONSE_TOO_LARGE'), { code: 'RELAY_RESPONSE_TOO_LARGE', status: 413 })
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, bytes)
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const DOOR_UPSTREAMS = {
  deepseek: { base: 'https://api.deepseek.com', secretKey: 'deepseek' },
  moonshot: { base: 'https://api.moonshot.ai', secretKey: 'moonshot' },
  'moonshot-cn': { base: 'https://api.moonshot.cn', secretKey: 'moonshot-cn' },
  openrouter: { base: 'https://openrouter.ai/api', secretKey: 'openrouter' },
  openai: { base: 'https://api.openai.com', secretKey: 'openai' },
  anthropic: { base: 'https://api.anthropic.com', secretKey: 'anthropic' },
  xai: { base: 'https://api.x.ai', secretKey: 'xai' },
}

// Per-request payload bound, including the 32 MiB mirror record plus its envelope.
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024
async function readBodyBuffer(req, limit = MAX_REQUEST_BODY_BYTES) {
  const refuse = () => { throw Object.assign(new Error('Request body exceeds the local host limit'), { code: 'REQUEST_BODY_TOO_LARGE', status: 413 }) }
  if (Number(req.headers['content-length'] ?? 0) > limit) refuse()
  const chunks = []
  let bytes = 0
  // Retain the response socket on overflow so the caller receives 413 before close.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (buffer.length > limit - bytes) refuse()
    bytes += buffer.length
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, bytes)
}

// AUMLOK and local broker bodies share a small budget and deadline. Refusal pauses reading;
// its route closes the response connection, rather than draining unbounded bytes.
function readAumlokBody(req, prefix = 'AUMLOK') {
  const length = req.headers['content-length']
  const error = (code, status = 400) => { const publicCode = code.replace(/^AUMLOK_/, prefix + '_'); return Object.assign(new Error(publicCode), { code: publicCode, status }) }
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) return Promise.reject(error('AUMLOK_BODY_INVALID'))
  if (Number(length ?? 0) > AUMLOK_LIMITS.requestBytes) return Promise.reject(error('AUMLOK_BODY_TOO_LARGE', 413))
  return new Promise((resolve, reject) => {
    let size = 0, settled = false
    const chunks = []
    const finish = failure => {
      if (settled) return
      settled = true
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', aborted); req.off('aborted', aborted)
      if (failure) { req.pause(); reject(failure); return }
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))) }
      catch (_error) { reject(error('AUMLOK_JSON_INVALID')) }
    }
    const data = chunk => {
      const buffer = Buffer.from(chunk)
      if (buffer.length > AUMLOK_LIMITS.requestBytes - size) { finish(error('AUMLOK_BODY_TOO_LARGE', 413)); return }
      size += buffer.length; chunks.push(buffer)
    }
    const end = () => finish(length !== undefined && Number(length) !== size ? error('AUMLOK_BODY_INVALID') : null)
    const aborted = () => finish(error('AUMLOK_BODY_ABORTED', 408))
    const timer = setTimeout(() => finish(error('AUMLOK_BODY_TIMEOUT', 408)), 10000)
    timer.unref()
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted)
    if (req.readableEnded) end()
    else if (req.destroyed || req.aborted) aborted()
  })
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

async function getGitBuildSha() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: REPO_ROOT, timeout: 3000 })
    return stdout.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

async function loadHeadBallState() {
  const headPath = path.join(MIRROR_BALLS_DIR, 'HEAD.json')
  const buildSha = await getGitBuildSha()
  try {
    const raw = await fsp.readFile(headPath, 'utf8')
    const head = JSON.parse(raw)
    const modules = {}
    const shas = new Set()
    if (head && typeof head.modules === 'object' && head.modules !== null) {
      for (const sha of Object.keys(head.modules)) shas.add(sha)
    }
    if (head && typeof head.entries === 'object' && head.entries !== null) {
      for (const entry of Object.values(head.entries)) {
        if (entry && typeof entry.specifier === 'string' && entry.specifier.startsWith('ball:')) {
          shas.add(entry.specifier.slice('ball:'.length))
        }
        if (entry && Array.isArray(entry.previousSpecifiers)) {
          for (const prev of entry.previousSpecifiers) {
            if (typeof prev === 'string' && prev.startsWith('ball:')) {
              shas.add(prev.slice('ball:'.length))
            }
          }
        }
      }
    }
    for (const sha of shas) {
      const modPath = path.join(MIRROR_BALLS_DIR, `${sha}.js`)
      try {
        modules[sha] = await fsp.readFile(modPath, 'utf8')
      } catch {}
    }
    return { head, ball: head, modules, codeBySha: modules, buildSha }
  } catch {
    return { head: null, ball: null, modules: {}, codeBySha: {}, buildSha }
  }
}


// The cloud mirror's secret-path rule (deploy/cloudflare/src/mirror-secret-paths.mjs: a secret name, its temp, lock,
// backup or swap siblings by the rule's closed suffix list, `.env*`, `.aukora-*`, `pepper.v1.*`), plus `.DS_Store`. Reject private directory descendants as well as their
// directory entries: such a path is never written here from a delta, walked into a snapshot, or listed by status.
function isSensitiveFilename(p) {
  return String(p || '').split('/').some(part => part === '.DS_Store' || secretShapedPart(part))
}

/** Map a VFS path (/dsh/home/... or /dsh/workspace/...) to a safe local path under MIRROR_DIR. */
function resolveMirrorDiskPath(vfsPath) {
  if (typeof vfsPath !== 'string') return null
  const normalized = path.posix.normalize(vfsPath)
  if (isSensitiveFilename(normalized)) return null
  // Neither deltas nor full snapshots may select a head, change immutable modules or erase their ancestors.
  if (normalized === '/dsh/home' || normalized === '/dsh/home/balls' || normalized.startsWith('/dsh/home/balls/')) return null
  if (normalized === '/dsh/home' || normalized.startsWith('/dsh/home/')) {
    const rel = normalized.slice('/dsh/home'.length).replace(/^\/+/, '')
    const target = path.resolve(MIRROR_HOME_DIR, rel)
    if (target === MIRROR_HOME_DIR || target.startsWith(MIRROR_HOME_DIR + path.sep)) return target
  }
  if (normalized === '/dsh/workspace' || normalized.startsWith('/dsh/workspace/')) {
    const rel = normalized.slice('/dsh/workspace'.length).replace(/^\/+/, '')
    const target = path.resolve(MIRROR_WORKSPACE_DIR, rel)
    if (target === MIRROR_WORKSPACE_DIR || target.startsWith(MIRROR_WORKSPACE_DIR + path.sep)) return target
  }
  return null
}

// AN OLD QUEUED SAVE IS NEVER REFUSED FOR A SECRET TEMP MARKER (the edge's
// publishableMirrorEntries). A browser that loaded the older page may still hold a save naming a credentials temp copy or
// lock as `gone`; refused, it would be retried for ever and block every later save. Such a `gone` (a well-formed path
// whose only fault is a secret-shaped part) is an applied no-op: validated, never preflighted, never written, counted
// as applied. A file or directory entry for such a path is still refused.
function inertMirrorEntry(item) {
  return Array.isArray(item) && item.length === 2 && item[1] !== null && typeof item[1] === 'object' && item[1].kind === 'gone' && secretShapedMirrorPath(item[0])
}

// A well-formed path whose only fault is the secret-path rule: its syntax is judged as sent, then where it would land
// with each matching part standing in for an ordinary name (never a ball path, never outside the mirror roots). The
// byte limits are checked first, so the rule never reads a part longer than 255 bytes.
function secretShapedMirrorPath(vfsPath) {
  if (typeof vfsPath !== 'string') return false
  const parts = vfsPath.split('/')
  if (vfsPath.includes('\0') || Buffer.byteLength(vfsPath) > 4096 || parts.some(segment => Buffer.byteLength(segment) > 255) || !parts.some(secretShapedPart) || path.posix.normalize(vfsPath) !== vfsPath) return false
  return resolveMirrorDiskPath(parts.map(part => secretShapedPart(part) ? 'secret-shaped' : part).join('/')) !== null
}

// CRASH RECOVERY ONLY (mirror-store.mjs recover): a FILE or DIRECTORY entry for such a path, which an older host
// journaled before the rule. Recovery stops a never-acknowledged batch at it and sets the batch aside; it is never applied.
function withheldMirrorEntry(item) {
  return Array.isArray(item) && item.length === 2 && item[1] !== null && typeof item[1] === 'object' && (item[1].kind === 'file' || item[1].kind === 'dir') && secretShapedMirrorPath(item[0])
}

function validateMirrorEntries(entries) {
  for (const item of entries) {
    if (inertMirrorEntry(item)) continue
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || item[0].includes('\0') || Buffer.byteLength(item[0]) > 4096 || item[0].split('/').some(segment => Buffer.byteLength(segment) > 255) || path.posix.normalize(item[0]) !== item[0] || !resolveMirrorDiskPath(item[0])) throw Object.assign(new Error('INVALID_MIRROR_PATH'), { status: 400 })
    const wire = item[1]
    if (!wire || typeof wire !== 'object' || !['gone', 'dir', 'file'].includes(wire.kind)) throw Object.assign(new Error('INVALID_MIRROR_ENTRY'), { status: 400 })
    if (wire.kind !== 'gone' && (!Number.isInteger(wire.mode) || wire.mode < 0 || wire.mode > 0o777)) throw Object.assign(new Error('INVALID_MIRROR_MODE'), { status: 400 })
    if (wire.kind === 'file' && (typeof wire.b64 !== 'string' || wire.b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(wire.b64) || !Number.isFinite(wire.mtimeMs) || wire.mtimeMs < 0 || !Number.isFinite(new Date(wire.mtimeMs).getTime()))) throw Object.assign(new Error('INVALID_MIRROR_FILE'), { status: 400 })
  }
}

async function preflightMirrorEntries(entries) {
  // Simulate the complete ordered batch before journaling. Deterministic parent
  // conflicts and symlinks must not become a permanently unapplicable pending batch.
  const nodes = new Map()
  const modes = new Map()
  const plannedModes = new Set()
  const owners = new Map()
  const cleared = new Set()
  const kindAt = async target => {
    if (nodes.has(target)) return nodes.get(target)
    if ([...cleared].some(root => target.startsWith(root + path.sep))) return null
    const stat = await fsp.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (stat?.isSymbolicLink()) throw Object.assign(new Error('MIRROR_SYMLINK_REFUSED'), { status: 400 })
    const kind = !stat ? null : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other'
    nodes.set(target, kind)
    if (stat) { modes.set(target, stat.mode & 0o777); owners.set(target, stat.uid) }
    return kind
  }
  const clearBelow = target => {
    cleared.add(target)
    for (const key of nodes.keys()) if (key.startsWith(target + path.sep)) { nodes.delete(key); modes.delete(key); plannedModes.delete(key); owners.delete(key) }
  }
  for (const [vfsPath, wire] of entries) {
    if (inertMirrorEntry([vfsPath, wire])) continue
    const target = resolveMirrorDiskPath(vfsPath)
    const parents = []
    for (let parent = path.dirname(target);; parent = path.dirname(parent)) {
      parents.unshift(parent)
      if (parent === MIRROR_DIR) break
    }
    for (let index = 0; index < parents.length; index += 1) {
      const parent = parents[index]
      const kind = await kindAt(parent)
      if (kind && kind !== 'dir') throw Object.assign(new Error('MIRROR_PARENT_NOT_DIRECTORY'), { status: 400 })
      const createsNextParent = wire.kind !== 'gone' && index + 1 < parents.length && await kindAt(parents[index + 1]) === null
      const required = index === parents.length - 1 || createsNextParent ? 0o300 : 0o100
      if (kind === 'dir') {
        if (plannedModes.has(parent)) {
          if ((modes.get(parent) & required) !== required) throw Object.assign(new Error('MIRROR_PARENT_NOT_WRITABLE'), { status: 400 })
        } else await fsp.access(parent, fs.constants.X_OK | (required & 0o200 ? fs.constants.W_OK : 0))
      }
      if (!kind && wire.kind !== 'gone') { nodes.set(parent, 'dir'); modes.set(parent, 0o755); plannedModes.add(parent) }
    }
    const previous = await kindAt(target)
    if (wire.kind === 'dir' && previous === 'dir' && typeof process.getuid === 'function' && process.getuid() !== 0 && owners.has(target) && owners.get(target) !== process.getuid()) throw Object.assign(new Error('MIRROR_DIRECTORY_NOT_OWNED'), { status: 400 })
    if (previous === 'other') throw Object.assign(new Error('MIRROR_ENTRY_TYPE_REFUSED'), { status: 400 })
    if (wire.kind === 'gone' || (previous && previous !== wire.kind)) clearBelow(target)
    nodes.set(target, wire.kind === 'gone' ? null : wire.kind)
    plannedModes.add(target)
    if (wire.kind === 'gone') modes.delete(target)
    else modes.set(target, wire.mode)
  }
}

async function refuseMirrorSymlinks(target) {
  const relative = path.relative(MIRROR_DIR, target)
  let current = MIRROR_DIR
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    const stat = await fsp.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (stat?.isSymbolicLink()) throw new Error('MIRROR_SYMLINK_REFUSED')
    if (!stat) break
  }
}

async function applyMirrorDelta(entries) {
  for (const [vfsPath, wire] of entries) {
    if (inertMirrorEntry([vfsPath, wire])) continue
    const diskPath = resolveMirrorDiskPath(vfsPath)
    if (!diskPath) throw new Error('Mirror path became unavailable')
    await refuseMirrorSymlinks(diskPath)
    await memoryHistory.beforeApply(diskPath, wire)
    if (wire.kind === 'gone') await fsp.rm(diskPath, { recursive: true, force: true })
    else {
      const current = await fsp.lstat(diskPath).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (current?.isSymbolicLink()) throw new Error('MIRROR_SYMLINK_REFUSED')
      if (wire.kind === 'dir') {
        if (current && !current.isDirectory()) await fsp.rm(diskPath)
        await fsp.mkdir(diskPath, { recursive: true, mode: wire.mode })
        await fsp.chmod(diskPath, wire.mode)
      } else {
        if (current?.isDirectory()) await fsp.rm(diskPath, { recursive: true })
        await atomicMirrorWrite(diskPath, Buffer.from(wire.b64, 'base64'), wire.mode, path.join(MIRROR_DIR, '.transport', 'temporary'))
        await fsp.chmod(diskPath, wire.mode)
        await fsp.utimes(diskPath, new Date(), new Date(wire.mtimeMs))
      }
    }
  }
  return entries.length
}

async function walkMirrorRoot(diskRoot, vfsPrefix, outEntries) {
  let dirEntries = []
  try {
    dirEntries = await fsp.readdir(diskRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const dirent of dirEntries) {
    if (dirent.name === '.DS_Store' || isSensitiveFilename(dirent.name)) continue
    const diskPath = path.join(diskRoot, dirent.name)
    const vfsPath = `${vfsPrefix}/${dirent.name}`
    if (vfsPath === '/dsh/home/balls/history' || vfsPath === '/dsh/home/cache') continue
    if (vfsPrefix === '/dsh/home/auma/snapshots' && dirent.name !== 'LATEST.json') continue
    if (dirent.isDirectory()) {
      outEntries.push([vfsPath, { kind: 'dir', mode: 0o755 }])
      await walkMirrorRoot(diskPath, vfsPath, outEntries)
    } else if (dirent.isFile()) {
      try {
        const st = await fsp.stat(diskPath)
        if (vfsPath.startsWith('/dsh/home/sessions/') && st.size > 4 * 1024 * 1024) continue
        const bytes = await fsp.readFile(diskPath)
        outEntries.push([
          vfsPath,
          {
            kind: 'file',
            b64: bytes.toString('base64'),
            mode: st.mode & 0o777,
            mtimeMs: Math.round(st.mtimeMs),
          },
        ])
      } catch {}
    }
  }
}

async function buildMirrorSnapshotEntries() {
  const entries = []
  await walkMirrorRoot(MIRROR_HOME_DIR, '/dsh/home', entries)
  await walkMirrorRoot(MIRROR_WORKSPACE_DIR, '/dsh/workspace', entries)
  return entries
}

const mirrorPublisher = createMirrorPublisher({
  directory: path.join(MIRROR_DIR, '.transport'), apply: applyMirrorDelta,
  validateEntries: validateMirrorEntries, preflightEntries: preflightMirrorEntries, readSnapshot: buildMirrorSnapshotEntries,
  withheldEntry: withheldMirrorEntry,
})
const localLiveUpdates = createLocalLiveUpdates({
  mirrorPublisher, runtimeHead, broadcast: update => broadcastLocalUpdate(activePeers.keys(), update),
})

// Exteroceptive Playwright Browser (`/_host/eyes`)
let eyesBrowserPromise = null
async function captureExteroceptiveEyes({ action = 'projection', selector = '', url = '' } = {}) {
  if (!eyesBrowserPromise) {
    const { chromium } = requireFromWeb('playwright')
    eyesBrowserPromise = chromium.launch({ headless: true }).catch((err) => {
      eyesBrowserPromise = null
      throw err
    })
  }
  const browser = await eyesBrowserPromise
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    await context.addCookies([
      {
        name: '__x6_cap',
        value: SESSION_CAP,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
      },
      {
        name: '__x6_cap',
        value: SESSION_CAP,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
      },
    ])
    const page = await context.newPage()
    const consoleErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200))
    })
    // Resolve requested URL: map virtual :3080 (WebWorker synthetic port) or relative URL to the live local host PORT (:4610)
    let targetPageUrl = `http://127.0.0.1:${PORT}/`
    let requestedUrlNote = undefined
    if (typeof url === 'string' && url.trim()) {
      const raw = url.trim()
      if (raw.includes(':3080')) {
        requestedUrlNote = `Mapped virtual worker port :3080 (${raw}) to live host UI http://127.0.0.1:${PORT}/`
      } else {
        try {
          const parsed = new URL(raw, `http://127.0.0.1:${PORT}/`)
          if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
            targetPageUrl = parsed.href
          }
        } catch {}
      }
    }
    await page.goto(targetPageUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    // Wait for the WebWorker VFS image + Cordis plugins to finish booting so we never photograph "Loading plugins..."
    await page.waitForFunction(
      () => {
        const txt = document.body?.innerText || ''
        return txt.length > 0 && !txt.includes('Loading plugins')
      },
      { timeout: 12_000 },
    ).catch(() => {})
    await page.waitForTimeout(400)

    const projection = await page.evaluate((sel) => {
      const rectOf = (el) => {
        if (!el || typeof el.getBoundingClientRect !== 'function') return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
        .slice(0, 12)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          rect: rectOf(el),
        }))
        .filter(h => h.text.length > 0)

      const interactiveElements = Array.from(
        document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="tab"]'),
      )
        .slice(0, 20)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          label: (
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.textContent ||
            ''
          ).replace(/\s+/g, ' ').trim().slice(0, 60),
          rect: rectOf(el),
        }))
        .filter(item => item.label || item.rect)

      const selectedEl = sel ? document.querySelector(sel) : null
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600)
      return {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        activeElement: document.activeElement
          ? {
              tag: document.activeElement.tagName.toLowerCase(),
              id: document.activeElement.id || undefined,
              rect: rectOf(document.activeElement),
            }
          : null,
        selectedTarget: selectedEl
          ? {
              selector: sel,
              tag: selectedEl.tagName.toLowerCase(),
              text: (selectedEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
              rect: rectOf(selectedEl),
            }
          : undefined,
        headings,
        interactiveCount: interactiveElements.length,
        interactiveElements,
        visibleTextExcerpt: bodyText,
      }
    }, selector || '')

    let pngBase64
    let screenshotPath
    if (action === 'screenshot') {
      const pngBuf = await page.screenshot({ type: 'png', fullPage: false })
      const capDir1 = path.join(MIRROR_HOME_DIR, 'auma-one', 'captures')
      const capDir2 = path.join(MIRROR_HOME_DIR, 'auma', 'captures')
      await fsp.mkdir(capDir1, { recursive: true })
      await fsp.mkdir(capDir2, { recursive: true })
      await fsp.writeFile(path.join(capDir1, 'latest.png'), pngBuf)
      await fsp.writeFile(path.join(capDir2, 'latest.png'), pngBuf)
      pngBase64 = pngBuf.toString('base64')
      screenshotPath = '/dsh/home/auma-one/captures/latest.png'
    }

    return {
      ok: true,
      action,
      ...(requestedUrlNote ? { requestedUrlNote } : {}),
      screenshotPath,
      pngBase64,
      projection,
      consoleErrors: consoleErrors.slice(0, 10),
    }
  } finally {
    await context.close().catch(() => {})
  }
}

const activePeers = new Map() // ws -> PeerInfo
const PEER_TTL_MS = 45_000

function getLivePeers() {
  const now = Date.now()
  const peers = []
  for (const [ws, peer] of activePeers.entries()) {
    if (ws.readyState !== 1) {
      activePeers.delete(ws)
      continue
    }
    if (peer) {
      peers.push({
        ...peer,
        alive: (now - (peer.lastSeenAt || now)) < PEER_TTL_MS,
      })
    }
  }
  return peers
}

function broadcastPresence() {
  const peers = getLivePeers()
  const msg = JSON.stringify({ type: 'presence:list', peers })
  for (const ws of activePeers.keys()) {
    if (ws.readyState === 1) ws.send(msg)
  }
}

function broadcastBallAnnouncement(ball, codeBySha, fromPeerId = 'local-head', excludeWs = null) {
  const peers = getLivePeers()
  const msg = JSON.stringify({ type: 'ball:commit', fromPeerId, ball, codeBySha, peers })
  for (const ws of activePeers.keys()) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(msg)
    }
  }
}

function isProtectedRoute(pathname) {
  return (
    pathname.startsWith('/_head/') ||
    pathname.startsWith('/_mirror/') ||
    pathname.startsWith('/_host/') ||
    pathname.startsWith('/_runtime/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/door/') ||
    pathname.startsWith('/download/')
  )
}

const lifecycle = createHostLifecycle({
  async canDrain() {
    const lease = await ballHeadStore.inspectLease()
    if (lease.lease) return 'WRITER_LEASE_ACTIVE'
    const markers = [
      [path.join(MIRROR_DIR, '.transport', 'pending.json'), 'MIRROR_PUBLICATION_PENDING'],
      [path.join(MIRROR_DIR, '.transport', 'pending-progress.json'), 'MIRROR_PUBLICATION_PENDING'],
      [path.join(assetCache.directory, 'runtime-head', 'pending.json'), 'RUNTIME_PUBLICATION_PENDING'],
      [path.join(assetCache.directory, 'runtime-head', 'WRITE.lock'), 'RUNTIME_WRITER_ACTIVE'],
      [path.join(assetCache.directory, 'CAPTURE.lock'), 'ASSET_CAPTURE_ACTIVE'],
      [path.join(REPO_ROOT, '.cache', 'x61-preview-build.lock'), 'PREVIEW_BUILD_ACTIVE'],
    ]
    for (const [file, code] of markers) {
      const exists = await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (exists) return code
    }
    return null
  },
  async stop() {
    await localWake.dispose()
    const httpClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeIdleConnections()
    const websocketClosed = new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve()))
    for (const ws of wss.clients) ws.close(1012, 'Host update')
    // Application handlers are settled; a peer may still omit its close handshake.
    const closeDeadline = setTimeout(() => { for (const ws of wss.clients) ws.terminate() }, 5000)
    closeDeadline.unref()
    try {
      await Promise.all([httpClosed, websocketClosed])
      if (eyesBrowserPromise) {
        const browser = await eyesBrowserPromise
        await browser.close()
        eyesBrowserPromise = null
      }
    } finally { clearTimeout(closeDeadline) }
  },
  onError: code => console.error('[x6.1-local-host] Lifecycle:', code),
})

const server = http.createServer(async (req, res) => {
  const observation = req.method === 'GET' && (req.url ?? '').split('?')[0] === '/_host/lifecycle'
  const settleRequest = lifecycle.trackHttp(res, observation)
  if (!settleRequest) {
    sendJson(res, 503, { ok: false, code: 'HOST_STOPPING', notApplied: true }, { Connection: 'close', 'Retry-After': '1' })
    return
  }
  try {
    const hostOriginCheck = verifyHostAndOrigin(req)
    if (!hostOriginCheck.ok) {
      sendJson(res, 403, { ok: false, error: `Forbidden: ${hostOriginCheck.reason}` })
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)
    const { pathname } = url

    if (pathname === '/_host/checkpoint-policy') {
      const cookies = parseCookies(req.headers.cookie)
      if (req.method !== 'GET' || url.search || url.hash
        || !(timingSafeEqualStr(req.headers['x-x6-capability'], SESSION_CAP) || timingSafeEqualStr(cookies.__x6_cap, SESSION_CAP))) {
        sendJson(res, 403, { ok: false, code: 'CHECKPOINT_POLICY_UNAVAILABLE' }); return
      }
      const policy = await checkpointPolicyView(process.env)
      if (!policy) { sendJson(res, 503, { ok: false, code: 'CHECKPOINT_POLICY_UNAVAILABLE' }); return }
      sendJson(res, 200, policy)
      return
    }

    if (pathname === '/_host/governance/verify') {
      try {
        const cookies = parseCookies(req.headers.cookie)
        if (req.method !== 'POST' || url.search || url.hash || req.headers.origin !== url.origin || req.headers['sec-fetch-site'] !== 'same-origin'
          || !(timingSafeEqualStr(req.headers['x-x6-capability'], SESSION_CAP) || timingSafeEqualStr(cookies.__x6_cap, SESSION_CAP))) {
          sendJson(res, 403, { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' }); return
        }
        const input = await readAumlokBody(req)
        if (!input || Object.keys(input).length !== 1 || input.binding?.schema !== 'aukora.class3.head-promotion.v1' || input.binding.audience !== url.origin) {
          sendJson(res, 400, { ok: false, code: 'CLASS3_ACTION_INVALID' }); return
        }
        const result = await localAumlok.verifyApproval(req.headers['x-x6-class3-approval'], input.binding, url.origin)
        sendJson(res, 200, result)
      } catch (error) {
        const result = aumlokFailureResult(error)
        sendJson(res, result.status, result)
      }
      return
    }

    // Unsupported invite actions must never enter passkey or enrollment handling.
    if (pathname === '/_host/aumlok/redeem' || pathname === '/_host/aumlok/invites') {
      sendJson(res, 501, { ok: false, code: 'AUMLOK_EDGE_ONLY_ROUTE' }, { 'X-Content-Type-Options': 'nosniff', Connection: 'close' })
      return
    }

    if (pathname === '/_host/aumlok' || pathname.startsWith('/_host/aumlok/')) {
      try {
        // Do not use verifyCapability's same-origin or query-token fallback here.
        const cookies = parseCookies(req.headers.cookie)
        if (!req.headers.host || !ALLOWED_ORIGINS.has(url.origin)
          || !(timingSafeEqualStr(req.headers['x-x6-capability'], SESSION_CAP) || timingSafeEqualStr(cookies.__x6_cap, SESSION_CAP))) {
          sendJson(res, 403, { ok: false, code: 'AUMLOK_CAPABILITY_REQUIRED' }, { Connection: 'close' }); return
        }
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value)
        const metadata = new Request(url, { method: req.method, headers })
        const action = aumlokRequestAction(metadata, [...ALLOWED_ORIGINS])
        const input = action === 'status' ? null : await readAumlokBody(req)
        const context = action === 'status' ? null : await localEnrollment.context(metadata, action)
        const result = action === 'status' ? await localAumlok.status() : action === 'challenge'
          ? await localAumlok.challenge(input, url.origin, context) : await localAumlok.complete(action, input, url.origin, context)
        sendJson(res, result.status ?? 200, result, { 'X-Content-Type-Options': 'nosniff', ...(!result.ok ? { Connection: 'close' } : {}) })
      } catch (error) {
        const result = aumlokFailureResult(error)
        sendJson(res, result.status, result, { 'X-Content-Type-Options': 'nosniff', Connection: 'close' })
      }
      return
    }

    // Local messaging still has no atomic passkey-consumption adapter.
    // A capability cookie or enrollment alone is not Class 3 consent.
    if (pathname === '/aukora-messages/send' && req.method === 'POST') {
      sendJson(res, 403, { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', notApplied: true }, { Connection: 'close' })
      return
    }

    // The isolated dispatcher authenticates before body, message-state, or receipt access.
    const messagesResponse = await handleLocalWakeRequest(req, url) ?? await handleLocalMessagesRequest(req, url)
    if (messagesResponse) {
      const body = Buffer.from(await messagesResponse.arrayBuffer())
      res.writeHead(messagesResponse.status, Object.fromEntries(messagesResponse.headers))
      res.end(body)
      return
    }

    // Reject cross-origin OPTIONS preflights; allow same-origin preflights without wildcard CORS
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }

    // Enforce per-session capability on all protected API / host / mirror / head / door routes
    if (isProtectedRoute(pathname)) {
      const capCheck = verifyCapability(req, url)
      if (!capCheck.ok) {
        sendJson(res, 403, { ok: false, error: `Forbidden: ${capCheck.reason}` })
        return
      }
      if (capCheck.issueCookie) {
        res.setHeader('Set-Cookie', `__x6_cap=${SESSION_CAP}; HttpOnly; SameSite=Strict; Path=/`)
      }
    }

    if (pathname === '/_host/lifecycle' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...lifecycle.status(), webSocketConnections: wss.clients.size })
      return
    }
    if (pathname === '/_host/lifecycle' && req.method === 'POST') {
      const body = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}')
      if (body.action === 'drain') sendJson(res, 202, { ok: true, ...lifecycle.requestDrain() })
      else if (body.action === 'cancel') {
        const result = lifecycle.cancelDrain()
        sendJson(res, result.ok ? 200 : 409, result)
      } else sendJson(res, 400, { ok: false, code: 'INVALID_HOST_LIFECYCLE_ACTION' })
      return
    }

    // Recovery UI is served by the host, without loading the replaceable worker.
    if ((pathname === '/recovery' || pathname === '/recovery/' || pathname === '/recovery/app.js' || pathname === '/recovery/style.css') && req.method === 'GET') {
      const file = pathname.endsWith('app.js') ? 'recovery.js' : pathname.endsWith('style.css') ? 'recovery.css' : 'recovery.html'
      const types = { 'recovery.html': 'text/html; charset=utf-8', 'recovery.js': 'text/javascript; charset=utf-8', 'recovery.css': 'text/css; charset=utf-8' }
      res.writeHead(200, { 'Content-Type': types[file], 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', ...(file === 'recovery.html' ? { 'Set-Cookie': `__x6_cap=${SESSION_CAP}; HttpOnly; SameSite=Strict; Path=/` } : {}) })
      res.end(await fsp.readFile(path.join(__dirname, file)))
      return
    }
    if (pathname === '/_head/recovery' && req.method === 'GET') {
      const target = url.searchParams.get('targetBallId')
      sendJson(res, 200, await ballHeadStore.recoveryView(target === null ? undefined : target))
      return
    }
    if (pathname === '/_head/recovery' && req.method === 'POST') {
      // Recovery is a new executable selection too. Reads remain available, but
      // no browser/agent may bypass the missing trusted transition verifier here.
      sendJson(res, 403, { ok: false, code: 'PEARL_QUALIFICATION_UNVERIFIABLE', notApplied: true }, { Connection: 'close' })
      return
    }

    if (pathname === '/_host/runtime-assets' && (req.method === 'GET' || req.method === 'POST')) {
      const result = req.method === 'POST' ? await assetCache.capture() : assetCache.status()
      const gate = await previewBuildGate()
      sendJson(res, result.ok ? 200 : 503, { ...result, buildLocked: gate.locked, buildPhase: gate.phase, previewBootBlocked: gate.blocked })
      return
    }

    if (pathname === '/_head/runtime') {
      try { planLocalRuntimeAction(req.method) } catch (error) {
        sendJson(res, error.status, { ok: false, code: error.code, notApplied: true }, { Connection: 'close' })
        return
      }
      const releases = await assetCache.listReleases()
      let selection
      try { selection = await localLiveUpdates.viewRuntime() } catch (error) { selection = { ok: false, error: error.code ?? error.message } }
      sendJson(res, 200, { ...releases, latestCapturedRelease: assetCache.status().latestRelease, selected: selection.ok ? selection.selected : null, selectionAvailable: false, selectionError: !selection.ok ? selection.error : 'PEARL_QUALIFICATION_UNVERIFIABLE', selectionIsNotHealthProof: true })
      return
    }
    const requestedCandidate = url.searchParams.get('runtime_candidate')
    const mainEntry = pathname === '/' || pathname === '/index.html' || pathname === '/preview.html'
    const candidateEntry = !isProtectedRoute(pathname) && !pathname.startsWith('/assets/') && !pathname.startsWith('/preview/') && (mainEntry || (req.headers.accept ?? '').includes('text/html'))
    const candidate = candidateEntry ? requestedCandidate : null
    if (requestedCandidate !== null && !candidateEntry && !isProtectedRoute(pathname)) { sendJson(res, 400, { ok: false, code: 'RUNTIME_ENTRY_UNAVAILABLE' }); return }
    const retainedPath = pathname.match(/^\/_runtime\/([a-f0-9]{64})\/(.+)$/)
    if ((candidate !== null || retainedPath) && (req.method === 'GET' || req.method === 'HEAD')) {
      const id = candidate ?? retainedPath[1]
      const file = candidate !== null ? 'preview.html' : retainedPath[2]
      if (candidate === null && (file === 'preview.html' || file === 'index.html')) {
        await assetCache.readRuntime(id, 'preview.html')
        res.writeHead(302, { Location: '/?runtime_candidate=' + id, 'Cache-Control': 'no-store' }); res.end(); return
      }
      const result = await assetCache.readRuntime(id, file, file === 'manifest.webmanifest' && url.searchParams.get('runtime_main') === '1')
      const ext = path.extname(file)
      const headers = { 'Content-Type': file.endsWith('.tar.gz') ? 'application/gzip' : (MIME_TYPES[ext] ?? 'application/octet-stream'), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-X6-Runtime-Release': id, 'X-X6-Source-Sha256': result.sourceSha256, 'X-X6-Response-Sha256': result.responseSha256 }
      if (candidate !== null) headers['Set-Cookie'] = `__x6_cap=${SESSION_CAP}; HttpOnly; SameSite=Strict; Path=/`
      res.writeHead(200, headers); res.end(result.bytes)
      return
    }
    if (candidate !== null) { sendJson(res, 405, { ok: false, code: 'RUNTIME_READ_ONLY' }); return }
    if (pathname.startsWith('/_runtime/')) { sendJson(res, 404, { ok: false, code: 'RUNTIME_FILE_UNAVAILABLE' }); return }
    if (candidateEntry && requestedCandidate === null && (req.method === 'GET' || req.method === 'HEAD')) {
      const selection = await localLiveUpdates.viewRuntime()
      if (selection.selected.releaseId) {
        const id = selection.selected.releaseId
        const result = await assetCache.readRuntime(id, 'preview.html', true)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-X6-Runtime-Release': id, 'X-X6-Runtime-Epoch': String(selection.selected.epoch), 'X-X6-Source-Sha256': result.sourceSha256, 'X-X6-Response-Sha256': result.responseSha256, 'Set-Cookie': `__x6_cap=${SESSION_CAP}; HttpOnly; SameSite=Strict; Path=/` })
        res.end(result.bytes); return
      }
    }


    // 1. AumaHead HTTP endpoints
    if (pathname === '/_head/status' || (pathname === '/_head/ball' && url.searchParams.has('meta'))) {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, code: 'METHOD_UNAVAILABLE' }); return }
      if (url.hash || (pathname === '/_head/status' ? url.href.includes('?') : url.search !== '?meta=1')) {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND' }); return
      }
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
        sendJson(res, 400, { ok: false, code: 'HEAD_REQUEST_INVALID' }); return
      }
      const result = await localHeadMetadata()
      sendJson(res, result.status ?? 200, result)
      return
    }
    if (pathname === '/_head/ball' && req.method === 'GET') {
      const state = await loadHeadBallState()
      sendJson(res, 200, { ok: true, ...state, peers: getLivePeers() })
      return
    }
    if (pathname === '/_head/lease' && (req.method === 'GET' || req.method === 'POST')) {
      const result = req.method === 'GET' ? await ballHeadStore.inspectLease() : await ballHeadStore.lease(JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}'))
      sendJson(res, result.status ?? 200, result)
      return
    }
    if (pathname === '/_head/ball' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}')
      const codeMap = body.codeBySha ?? body.modules ?? {}
      const result = await publishQualifiedLocalHead({
        ball: body.ball, codeBySha: codeMap,
        expectedParentBallId: body.expectedParentBallId, expectedEpoch: body.expectedEpoch, writerLease: body.writerLease,
      })
      if (result.ok) broadcastBallAnnouncement(body.ball, codeMap, body.fromPeerId ?? 'local-head')
      sendJson(res, result.status ?? 200, result)
      return
    }

    // 2. Live VFS Repo Mirror endpoints
    if (pathname === '/_mirror/delta' && req.method === 'POST') {
      const body = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}')
      const result = body.v === 2 ? await localLiveUpdates.publishMirror(body) : { ok: false, status: 409, code: 'MIRROR_OUTBOX_PROTOCOL_REQUIRED' }
      sendJson(res, result.status ?? 200, result)
      return
    }
    if (pathname === '/_mirror/memory-history' && req.method === 'GET') {
      sendJson(res, 200, await memoryHistory.inspect())
      return
    }
    if (pathname === '/_mirror/status' && req.method === 'GET') {
      const state = await loadHeadBallState()
      const homeFiles = (await fsp.readdir(MIRROR_HOME_DIR, { recursive: true }).catch(() => []))
        .filter(f => !isSensitiveFilename(f))
      const workspaceFiles = (await fsp.readdir(MIRROR_WORKSPACE_DIR, { recursive: true }).catch(() => []))
        .filter(f => !isSensitiveFilename(f))
      sendJson(res, 200, {
        ok: true,
        repoRoot: REPO_ROOT,
        mirrorDir: MIRROR_DIR,
        head: state.head,
        moduleCount: Object.keys(state.modules).length,
        homeFiles,
        workspaceFiles,
        peers: getLivePeers(),
      })
      return
    }
    if (pathname === '/api/snapshot') {
      if (req.method === 'GET') {
        const entries = await mirrorPublisher.snapshot()
        sendJson(res, 200, { ok: true, entries })
        return
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        sendJson(res, 409, { ok: false, code: 'MIRROR_OUTBOX_PROTOCOL_REQUIRED', error: 'Snapshot writes must use the ordered mirror outbox.' })
        return
      }
    }

    // 2b. Seed Pack Download & Export/Import (`/download/pack/:sha`, `/api/seed/export`)
    if (pathname.startsWith('/download/pack/') && req.method === 'GET') {
      const wantedSha = pathname.slice('/download/pack/'.length).replace(/\.json\.gz$/, '').trim()
      const seedDir = path.join(MIRROR_HOME_DIR, 'auma', 'seed')
      const files = await fsp.readdir(seedDir).catch(() => [])
      for (const file of files) {
        if (!file.endsWith('.json.gz')) continue
        const fullPath = path.join(seedDir, file)
        const bytes = await fsp.readFile(fullPath).catch(() => null)
        if (!bytes) continue
        const digest = crypto.createHash('sha256').update(bytes).digest('hex')
        if (digest === wantedSha || wantedSha === 'latest' || file.includes(wantedSha)) {
          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="${file}"`,
            'X-Seed-Pack-Sha256': digest,
            'Cache-Control': 'no-store',
          })
          res.end(bytes)
          return
        }
      }
      sendJson(res, 404, { ok: false, error: `Seed pack not found for sha: ${wantedSha}` })
      return
    }

    if (pathname === '/api/seed/export' && req.method === 'GET') {
      const seedDir = path.join(MIRROR_HOME_DIR, 'auma', 'seed')
      const files = (await fsp.readdir(seedDir).catch(() => []))
        .filter(f => f.endsWith('.json.gz'))
        .sort()
        .reverse()
      if (files.length === 0) {
        sendJson(res, 404, { ok: false, error: 'No packed .json.gz found in /dsh/home/auma/seed' })
        return
      }
      const latestFile = files[0]
      const bytes = await fsp.readFile(path.join(seedDir, latestFile))
      const digest = crypto.createHash('sha256').update(bytes).digest('hex')
      sendJson(res, 200, {
        ok: true,
        file: `/dsh/home/auma/seed/${latestFile}`,
        packSha256: digest,
        gzipBytes: bytes.length,
        downloadUrl: `/download/pack/${digest}`,
        base64: bytes.toString('base64'),
      })
      return
    }

    // These model-facing observations never invoke Git, a shell, gh, or Wrangler.
    if (['/_host/repo', '/_host/github', '/_host/cloudflare'].includes(pathname)) {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, code: 'METHOD_UNAVAILABLE' }, { Connection: 'close' }); return }
      const surface = pathname.slice('/_host/'.length)
      try {
        if (url.search || url.hash) throw Object.assign(new Error('LOCAL_BROKER_REQUEST_INVALID'), { code: 'LOCAL_BROKER_REQUEST_INVALID', status: 400 })
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) throw Object.assign(new Error('LOCAL_BROKER_CONTENT_TYPE_REQUIRED'), { code: 'LOCAL_BROKER_CONTENT_TYPE_REQUIRED', status: 415 })
        const plan = planLocalBrokerAction(surface, await readAumlokBody(req, 'LOCAL_BROKER'))
        if (plan.kind === 'repository-status') sendJson(res, 200, { ok: true, ...await readModelRepositoryStatus(REPO_ROOT) })
        else if (plan.kind === 'source-read') sendJson(res, 200, { ok: true, path: plan.path, content: await readModelSourceFile(REPO_ROOT, plan.path) })
        else if (plan.kind === 'integration-status') sendJson(res, 200, { ok: true, action: 'status', surface, policy: MODEL_HOST_POLICY, authentication: 'not-checked', writesAvailable: false, cliAvailable: false, apiAvailable: false })
        else sendJson(res, 503, { ok: false, code: plan.code, action: plan.action, notApplied: true })
      } catch (error) {
        const known = /^(?:LOCAL_|MODEL_|PEARL_|CLASS3_)/.test(error?.code ?? '')
        sendJson(res, known ? error.status ?? 503 : 503, { ok: false, code: known ? error.code : 'LOCAL_REPO_READ_UNAVAILABLE', notApplied: true }, { Connection: 'close' })
      }
      return
    }

    // 3a-owner. Host Owner Ed25519 Front Door (`/_host/owner-key` & `/_host/owner-grant`)
    if (pathname.startsWith('/_host/owner-key') || pathname.startsWith('/_host/owner-grant')) {
      const result = await handleLocalOwnerGrant(req, url)
      sendJson(res, result.status, result.body, { 'X-Content-Type-Options': 'nosniff' })
      return
    }

    // 3c. Exteroceptive Eyes (`/_host/eyes`) — ~2KB Structural Projection + On-Demand PNG Screenshot
    if (pathname === '/_host/eyes' && req.method === 'POST') {
      const body = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}')
      try {
        const result = await captureExteroceptiveEyes({
          action: body.action || 'projection',
          selector: body.selector || '',
          url: body.url || '',
        })
        sendJson(res, 200, result)
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    // 3d. Web-Eyes Internet Fetch & Search (`/_host/web-eyes`) with SSRF protection
    if (pathname === '/_host/web-eyes' && req.method === 'POST') {
      const body = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}')
      const action = body.action ?? 'fetch'
      try {
        if (action === 'fetch') {
          const targetUrl = String(body.url ?? '').trim()
          if (!targetUrl) {
            sendJson(res, 400, { ok: false, error: 'web-eyes fetch requires `url`' })
            return
          }
          const check = validateRelayTargetUrl(targetUrl)
          if (!check.ok) {
            sendJson(res, check.status ?? 403, { ok: false, code: check.code ?? 'WEB_EYES_URL_REFUSED', error: check.error })
            return
          }
          const maxLen = typeof body.maxLength === 'number' && Number.isSafeInteger(body.maxLength) && body.maxLength > 0 ? Math.min(body.maxLength, 80_000) : 80_000
          const reqHeaders = {
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) AumaWebEyes/6.1',
            'accept': 'text/html,application/xhtml+xml,application/json,text/markdown,text/plain;q=0.9,*/*;q=0.8',
          }
          if (check.isLocalStatusProbe) {
            reqHeaders['x-x6-capability'] = SESSION_CAP
          }
          const upstreamRes = await fetch(check.url, {
            headers: reqHeaders,
            redirect: 'manual', signal: AbortSignal.timeout(10000),
          })
          if (upstreamRes.status >= 300 && upstreamRes.status < 400) { void upstreamRes.body?.cancel().catch(_error => {}); sendJson(res, 502, { ok: false, code: 'RELAY_REDIRECT_REFUSED' }); return }
          const contentType = upstreamRes.headers.get('content-type') ?? 'text/plain'
          const rawText = new TextDecoder().decode(await boundedRelayBytes(upstreamRes))
          let title = ''
          let readable = rawText
          if (contentType.includes('text/html') || rawText.trimStart().startsWith('<!DOCTYPE') || rawText.trimStart().startsWith('<html')) {
            const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
            if (titleMatch) {
              title = titleMatch[1].replace(/\s+/g, ' ').trim()
            }
            readable = rawText
              .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
              .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
              .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
              .replace(/<(h[1-6]|p|div|section|article|li|tr|br)\b[^>]*>/gi, '\n')
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
          if (readable.length > maxLen) {
            readable = `${readable.slice(0, maxLen)}\n\n[...truncated at ${String(maxLen)} chars]`
          }
          sendJson(res, 200, {
            ok: true,
            url: targetUrl,
            finalUrl: upstreamRes.url || targetUrl,
            status: upstreamRes.status,
            title: title || undefined,
            contentType,
            content: readable,
          })
          return
        }
        if (action === 'search') {
          const query = String(body.query ?? '').trim()
          const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.min(body.limit, 20) : 8
          if (!query) {
            sendJson(res, 400, { ok: false, error: 'web-eyes search requires `query`' })
            return
          }
          if (query.length > 2048) { sendJson(res, 400, { ok: false, code: 'WEB_EYES_QUERY_TOO_LARGE' }); return }
          const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
          const upstreamRes = await fetch(ddgUrl, {
            redirect: 'manual', signal: AbortSignal.timeout(10000),
            headers: {
              'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              'accept': 'text/html',
            },
          })
          if (upstreamRes.status >= 300 && upstreamRes.status < 400) { void upstreamRes.body?.cancel().catch(_error => {}); sendJson(res, 502, { ok: false, code: 'RELAY_REDIRECT_REFUSED' }); return }
          const html = new TextDecoder().decode(await boundedRelayBytes(upstreamRes))
          const results = []
          const blockRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi
          let match
          while ((match = blockRegex.exec(html)) !== null && results.length < limit) {
            let href = match[1]
            const uddgMatch = href.match(/[?&]uddg=([^&]+)/)
            if (uddgMatch) {
              try { href = decodeURIComponent(uddgMatch[1]) } catch {}
            }
            const cleanTitle = (match[2] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
            const cleanSnippet = (match[3] ?? match[4] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
            if (href && cleanTitle && href.startsWith('http')) {
              results.push({ title: cleanTitle, url: href, snippet: cleanSnippet })
            }
          }
          sendJson(res, 200, { ok: true, query, results })
          return
        }
        sendJson(res, 400, { ok: false, error: `Unknown /_host/web-eyes action: ${String(action)}` })
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          action,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    // 4. Vault Door (`/door/<provider>/*` and `/api/fetch`)
    if (pathname.startsWith('/door/')) {
      const rest = pathname.slice('/door/'.length)
      const slash = rest.indexOf('/')
      const provider = slash === -1 ? rest : rest.slice(0, slash)
      const upstreamPath = slash === -1 ? '' : rest.slice(slash)
      const door = DOOR_UPSTREAMS[provider]
      if (!door || !/^\/(?:(?:anthropic\/)?v1\/)?(?:models|chat\/completions|messages|responses)$/.test(upstreamPath) || url.search || url.hash
        || (upstreamPath.endsWith('/models') ? req.method !== 'GET' : req.method !== 'POST')) {
        sendJson(res, 404, { ok: false, code: 'DOOR_NOT_FOUND', error: `Unknown or disallowed model door path: ${pathname}` })
        return
      }
      const limits = providerBudgetLimits(process.env)
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') { sendJson(res, 400, { ok: false, code: 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED' }); return }
      const bodyBuf = req.method === 'GET' ? undefined : await readBodyBuffer(req, 256 * 1024)
      const reservation = providerRequestReservation(bodyBuf, limits, upstreamPath)
      const targetUrl = `${door.base}${upstreamPath}`
      const headers = new Headers({ 'content-type': 'application/json' })
      const vaultSecrets = await loadVaultSecrets()
      const vaultSecret = vaultSecrets[door.secretKey]
      if (!vaultSecret) { sendJson(res, 503, { ok: false, code: 'PROVIDER_SECRET_NOT_CONFIGURED' }); return }
      if (vaultSecret) {
        if (provider === 'anthropic') {
          headers.set('x-api-key', vaultSecret)
          headers.set('anthropic-version', '2023-06-01')
        } else if (upstreamPath.startsWith('/anthropic/')) {
          headers.set('authorization', `Bearer ${vaultSecret}`)
          headers.set('x-api-key', vaultSecret)
          headers.set('anthropic-version', '2023-06-01')
        } else {
          headers.set('authorization', `Bearer ${vaultSecret}`)
        }
      }
      await reserveProviderBudget(localProviderBudget, { provider, tokens: reservation.tokens }, limits)
      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: reservation.bodyBytes,
        redirect: 'manual', signal: AbortSignal.timeout(120000),
      })
      if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
        void upstreamRes.body?.cancel().catch(_error => {})
        sendJson(res, 502, { ok: false, code: 'PROVIDER_REDIRECT_REFUSED' }); return
      }
      const responseHeaders = { 'Cache-Control': 'no-store' }
      const ct = upstreamRes.headers.get('content-type')
      if (ct) responseHeaders['Content-Type'] = ct
      res.writeHead(upstreamRes.status, responseHeaders)
      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) {
          res.write(chunk)
        }
      }
      res.end()
      return
    }

    if (pathname === '/api/fetch') {
      if (!['GET', 'HEAD'].includes(req.method) || req.headers['transfer-encoding'] || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
        sendJson(res, 403, { ok: false, code: 'RELAY_READ_ONLY_REQUIRED' }, { Connection: 'close' }); return
      }
      const queryUrl = url.searchParams.get('url')
      const headerUrl = req.headers['x-dsh-target-url']
      const targetUrl = (typeof queryUrl === 'string' && queryUrl) ? queryUrl : (typeof headerUrl === 'string' ? headerUrl : '')
      if (!targetUrl) {
        sendJson(res, 400, { error: 'Missing ?url=<target> query param or X-DSH-Target-URL header' })
        return
      }
      const check = validateRelayTargetUrl(targetUrl)
      if (!check.ok) {
        sendJson(res, check.status ?? 403, { ok: false, code: check.code ?? 'RELAY_URL_REFUSED', error: check.error })
        return
      }
      const headers = new Headers()
      if (typeof req.headers['x-relay-accept'] === 'string') headers.set('accept', req.headers['x-relay-accept'])
      if (typeof req.headers['x-relay-user-agent'] === 'string') headers.set('user-agent', req.headers['x-relay-user-agent'])
      if (typeof req.headers['x-relay-accept-language'] === 'string') headers.set('accept-language', req.headers['x-relay-accept-language'])
      if (check.isLocalStatusProbe) headers.set('x-x6-capability', SESSION_CAP)
      for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase()
        if (
          !v ||
          [
            'host',
            'connection',
            'content-length',
            'transfer-encoding',
            'x-dsh-target-url',
            'x-relay-accept',
            'x-relay-user-agent',
            'x-relay-accept-language',
            'origin',
            'referer',
            'cookie',
            'x-x6-capability',
          ].includes(lower)
        ) {
          continue
        }
        if (!headers.has(lower)) {
          headers.set(k, Array.isArray(v) ? v.join(', ') : v)
        }
      }
      const bodyBuf = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : await readBodyBuffer(req)
      const upstreamRes = await fetch(check.url, {
        method: req.method,
        headers,
        body: bodyBuf,
        redirect: 'manual', signal: AbortSignal.timeout(10000),
      })
      if (upstreamRes.status >= 300 && upstreamRes.status < 400) { void upstreamRes.body?.cancel().catch(_error => {}); sendJson(res, 502, { ok: false, code: 'RELAY_REDIRECT_REFUSED' }); return }
      const relayBytes = await boundedRelayBytes(upstreamRes)
      const responseHeaders = {
        'Cache-Control': 'no-store',
        'x-relay': '1',
        'x-relay-status': String(upstreamRes.status),
        'X-DSH-Final-URL': upstreamRes.url || check.url,
      }
      upstreamRes.headers.forEach((val, key) => {
        const lower = key.toLowerCase()
        if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(lower)) {
          responseHeaders[`x-relay-h-${lower}`] = val
        }
      })
      const ct = upstreamRes.headers.get('content-type')
      if (ct) responseHeaders['Content-Type'] = ct
      res.writeHead(200, responseHeaders)
      res.end(relayBytes)
      return
    }

    // 5. Static WebWorker Preview Frontend (`apps/web/dist`)
    // Serve `preview.html` on `/` and `/preview.html`, issuing the HttpOnly SameSite=Strict session capability cookie.
    const relativeReqPath = (pathname === '/' || pathname === '/index.html' || pathname === '/preview.html')
      ? 'preview.html'
      : pathname.replace(/^\/+/, '')
    const diskFile = path.resolve(DIST_DIR, relativeReqPath)
    if (diskFile !== DIST_DIR && !diskFile.startsWith(DIST_DIR + path.sep)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    const serveRetained = retained => {
      const ext = path.extname(relativeReqPath)
      res.writeHead(200, { 'Content-Type': relativeReqPath.endsWith('.tar.gz') ? 'application/gzip' : (MIME_TYPES[ext] ?? 'application/octet-stream'), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-X6-Retained-Sha256': retained.sha256 })
      res.end(retained.bytes)
    }
    const initialBuildGate = await previewBuildGate()
    const serveDuringTransition = async () => {
      const retained = immutablePath(relativeReqPath) ? await assetCache.read(relativeReqPath) : null
      if (retained) serveRetained(retained)
      else { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '2', 'Cache-Control': 'no-store' }); res.end('Preview build transition requires completion or inspection. New boots wait; existing tabs are not reloaded. Recovery remains available at /recovery/. Inspect an interrupted build before clearing its lock.') }
    }
    if (initialBuildGate.blocked) { await serveDuringTransition(); return }
    const readStatic = async file => {
      const source = await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error })
      if (!source) return null
      const real = await fsp.realpath(file).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error })
      if (!real) return null
      if (source.isSymbolicLink() || real !== file) throw new Error('STATIC_SYMLINK_REFUSED')
      const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error })
      if (!handle) return null
      try {
        const before = await handle.stat()
        if (!before.isFile()) return null
        if (before.dev !== source.dev || before.ino !== source.ino) return null
        if (before.size > 128 * 1024 * 1024) throw new Error('STATIC_FILE_BYTE_BUDGET')
        const bytes = await handle.readFile()
        const after = await handle.stat()
        if (bytes.length !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null
        return bytes
      } finally { await handle.close() }
    }
    let fileToServe = diskFile
    let staticBytes = await readStatic(fileToServe)
    if (!staticBytes) {
      const retained = await assetCache.read(relativeReqPath)
      if (retained) {
        serveRetained(retained)
        return
      }
      if (!relativeReqPath.startsWith('assets/') && !relativeReqPath.startsWith('preview/') && (req.headers.accept ?? '').includes('text/html')) {
        fileToServe = path.join(DIST_DIR, 'preview.html')
        staticBytes = await readStatic(fileToServe)
      }
    }
    if (!staticBytes) {
      const missingGate = await previewBuildGate()
      if (missingGate.blocked || missingGate.signature !== initialBuildGate.signature) { await serveDuringTransition(); return }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Not found: ${pathname}`)
      return
    }

    const finalBuildGate = await previewBuildGate()
    if (finalBuildGate.blocked || finalBuildGate.signature !== initialBuildGate.signature) { await serveDuringTransition(); return }
    assetCache.assertCurrent(relativeReqPath, staticBytes)
    const ext = path.extname(fileToServe)
    const contentType = fileToServe.endsWith('.tar.gz')
      ? 'application/gzip'
      : (MIME_TYPES[ext] ?? 'application/octet-stream')
    const staticHeaders = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    }
    if (ext === '.html') {
      staticHeaders['Set-Cookie'] = `__x6_cap=${SESSION_CAP}; HttpOnly; SameSite=Strict; Path=/`
    }
    res.writeHead(200, staticHeaders)
    res.end(staticBytes)
  } catch (err) {
    if (res.destroyed || res.writableEnded) return
    if (req.aborted || res.headersSent) { res.destroy(); return }
    if (/^(?:PROVIDER_|RELAY_)/.test(err?.code ?? '')) { sendJson(res, [400, 403, 404, 413, 429, 502, 503].includes(err.status) ? err.status : 503, { ok: false, code: err.code }, { Connection: 'close' }); return }
    sendJson(res, err.status ?? 500, { error: err instanceof Error ? err.message : String(err), ...(err.code === 'REQUEST_BODY_TOO_LARGE' ? { code: err.code } : {}) }, err.status === 413 ? { Connection: 'close' } : {})
  } finally { settleRequest() }
})

// WebSocket server on `/_head/ws` for AumaHead live presence + multi-tab ball broadcast
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  if (!lifecycle.accepting()) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    return
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${HOST}:${PORT}`}`)
  if (url.pathname !== '/_head/ws') {
    socket.destroy()
    return
  }
  const capCheck = authorizeLocalHeadWebSocket(request, url, { sessionCapability: SESSION_CAP, allowedOrigins: ALLOWED_ORIGINS, verifyHostAndOrigin })
  if (!capCheck.ok) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

wss.on('connection', async (ws) => {
  const settleConnection = lifecycle.beginWebSocketOperation()
  if (!settleConnection) { ws.close(1012, 'Host update'); return }
  activePeers.set(ws, null)
  ws.on('close', () => {
    activePeers.delete(ws)
    broadcastPresence()
  })
  try {
    const state = await loadHeadBallState()
    if (ws.readyState !== 1) return
    if (state.ball) {
      ws.send(JSON.stringify({
        type: 'ball:commit',
        fromPeerId: 'local-head',
        ball: state.ball,
        codeBySha: state.codeBySha,
        peers: getLivePeers(),
      }))
    }
    broadcastPresence()

    ws.on('message', async (raw) => {
      const settleMessage = lifecycle.beginWebSocketOperation()
      if (!settleMessage) { ws.close(1012, 'Host update'); return }
      try {
        const data = JSON.parse(raw.toString())
        if (data.peer && data.peer.peerId) {
          activePeers.set(ws, { ...data.peer, lastSeenAt: Date.now() })
          broadcastPresence()
        }
        if ((data.type === 'ball:commit' || data.t === 'ball_announce') && data.ball) {
          const codeMap = data.codeBySha ?? data.modules ?? {}
          const result = await publishQualifiedLocalHead({
            ball: data.ball, codeBySha: codeMap,
            expectedParentBallId: data.expectedParentBallId, expectedEpoch: data.expectedEpoch, writerLease: data.writerLease,
          })
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: result.ok ? 'ball:ack' : 'ball:rejected', ...result }))
          if (!result.ok) return
          if (activePeers.get(ws)) {
            activePeers.set(ws, {
              ...activePeers.get(ws),
              ballId: data.ball.ballId ?? data.ball.ballSha,
              lastSeenAt: Date.now(),
            })
          }
          broadcastBallAnnouncement(data.ball, codeMap, data.fromPeerId ?? 'peer', ws)
          broadcastPresence()
        }
      } catch (error) {
        // Malformed or disconnected peer traffic does not stop other peers.
      } finally { settleMessage() }
    })
  } catch (error) {
    console.error('[x6.1-local-host] WebSocket initialization unavailable')
    ws.close(1011, 'Head unavailable')
  } finally { settleConnection() }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    lifecycle.requestDrain()
    console.log('[x6.1-local-host] Waiting for active work before shutdown')
  })
}

// Baseline copies must be durable before any mirror mutation can be accepted.
await memoryHistory.initialize()
const retention = await assetCache.capture()
if (!retention.ok) console.error('[x6.1-local-host] Build asset retention unavailable:', retention.error)

const wakeStatus = await localWake.start()
if (!wakeStatus.ok) console.error('[x6.1-local-host] Local wake schedule unavailable:', wakeStatus.code)

server.listen(PORT, HOST, () => {
  console.log(`[x6.1-local-host] AUKORA X6.1 hardened runtime listening on http://${HOST}:${PORT}`)
  console.log(`[x6.1-local-host] Repo root:   ${REPO_ROOT}`)
  console.log(`[x6.1-local-host] Live mirror: ${MIRROR_DIR}`)
  console.log(`[x6.1-local-host] Vault dir:   ${VAULT_DIR} (mode 0700, session.cap + credentials.yaml outside repo)`)
})
