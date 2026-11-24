#!/usr/bin/env node
/**
 * verify-personaplex-zero-secret.mjs — fail-closed checks for deploy/personaplex.
 *
 * 1. ZERO CREDENTIALS: no secret-shaped literal in any file; no credential-named ARG/ENV (both
 *    forms), secret mount, build-context COPY, unpinned base image or un-checksummed ADD in the
 *    Dockerfile; the security-relevant heredoc bodies (launch.sh, healthcheck, fetch, gateway, its
 *    tests, both pin lists) are byte-pinned by sha256 below, so any edit to them must also edit this
 *    file in the same reviewed diff; the renderer runs offline, numerically non-root, entrypoint
 *    exactly launch.sh; the compose file (README block, and --compose FILE for the deployed one) has
 *    exactly the three services with allow-listed keys, exact networks and exact mounts.
 * 2. INGRESS: the cloudflared config has exactly one hostname rule (the Worker's PERSONAPLEX_WS_URL
 *    host, no wildcard), path ^/api/chat$, origin http://gateway:8080, Cloudflare Access JWT
 *    validation required UNDER that rule (a top-level originRequest.access is silently ignored by
 *    cloudflared), then a bare http_status:404. That the Access policy admits only the your-node
 *    Worker's service token is a Cloudflare-side setting this script cannot see.
 *
 * usage:
 *   node deploy/personaplex/verify-personaplex-zero-secret.mjs                 # repo files (example config may keep <placeholders>)
 *   node deploy/personaplex/verify-personaplex-zero-secret.mjs --config FILE   # a filled config: no placeholders allowed
 *     [--team NAME] [--compose FILE] [--env-file FILE] [--expect-url wss://voice.example.invalid/api/chat]
 *     [--runtime CONTAINER] [--json]
 *   node deploy/personaplex/verify-personaplex-zero-secret.mjs --self-test     # mutation tests of the checks themselves
 *
 * Exit 0 only when every check passes. Prints names and locations, never secret values.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const SECRET_LITERALS = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{16,}/],
  ['openai-style key', /\bsk-[A-Za-z0-9]{32,}/],
  ['github token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['huggingface token', /\bhf_[A-Za-z0-9]{30,}/],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  ['cloudflare tunnel token', /\beyJhIjoi[A-Za-z0-9_-]{20,}/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
]
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSW(OR)?D|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i
const ALLOWED_CREDENTIAL_SHAPED_NAMES = new Set(['GATEWAY_TOKEN_SHA256', 'TORCH_FORCE_WEIGHTS_ONLY_LOAD'])
const ENV_FILE_KEYS = new Set(['GATEWAY_TOKEN_SHA256', 'PERSONAPLEX_ALLOW_FREE_RENDER'])
const HEREDOC_OPEN = /<<-?\s*(["']?)([A-Z][A-Z0-9_]*)\1/
// sha256 of each heredoc body (by target path). Re-pin ONLY in the same reviewed diff as the body.
const PINNED_BODIES = {
  '/src/renderer.requirements.txt': 'a63b3d216dca9bdb2468338d67a59f5fdb004aaf945e159c04f234cf8f5fd95b',
  '/opt/voice/launch.sh': 'ea99bc22d4f7c70d583e08c4ee0e947d81781a5a92ffc4978c80c6552c4ee818',
  '/opt/voice/healthcheck.py': '912e6bf1c9298d38ee8ab5699a3697ee2e19961ce385726750432a735dd9aba4',
  '/opt/voice/fetch_weights.py': '461673b63ceaa1343a6b6136f5627d41449be5e2397b0e48af1a53a468e6a4a5',
  '/tmp/gateway.requirements.txt': '67c3868a48b97cd39be0743efc7913e5fb16d3764fd6e7bf2231a39989fb6c94',
  '/opt/gateway/gateway.py': 'd236e09ca9605eb699f066ada4578d38b61443419b10b8bdf768678f7501d413',
  '/etc/voice/text-prompt.txt': 'f6ecc6da787e3b69ec79e251e7e465df51024f93bda1d073a392dafe1828ba99',
  '/opt/gateway/test_gateway.py': '0b5cde7af78554b9df9e8a0d0352064fa0ca22d4c58dbdc13ab2a080fa7b9756',
}
const RENDERER_VOLUMES = ['/etc/aukora/voice-pin:/etc/voice-pin:ro', 'personaplex-hf-cache:/models:ro']
const SERVICE_KEYS = {
  renderer: ['image', 'restart', 'networks', 'read_only', 'tmpfs', 'cap_drop', 'security_opt', 'pids_limit', 'mem_limit', 'memswap_limit', 'dns', 'volumes', 'deploy'],
  gateway: ['image', 'restart', 'networks', 'read_only', 'cap_drop', 'security_opt', 'pids_limit', 'mem_limit', 'environment', 'depends_on'],
  cloudflared: ['image', 'restart', 'networks', 'read_only', 'cap_drop', 'security_opt', 'pids_limit', 'mem_limit', 'dns', 'command', 'volumes', 'depends_on'],
}
const SERVICE_NETWORKS = { renderer: ['renderer_net'], gateway: ['renderer_net', 'tunnel_net'], cloudflared: ['egress_net', 'tunnel_net'] }
const CLOUDFLARED_VOLUMES = ['/etc/aukora/voice-cloudflared.yml:/etc/cloudflared/config.yml:ro', '/etc/aukora/voice-tunnel.json:/etc/cloudflared/credentials.json:ro']
const sha256 = text => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
const same = (a, b) => JSON.stringify([...(a ?? [])].map(String).sort()) === JSON.stringify([...b].sort())

function parseArgs(argv) {
  const out = { config: null, team: null, compose: null, envFile: null, expectUrl: 'wss://voice.example.invalid/api/chat', runtime: null, json: false, selfTest: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') out.config = argv[++i]
    else if (a === '--env-file') out.envFile = argv[++i]
    else if (a === '--team') out.team = argv[++i]
    else if (a === '--compose') out.compose = argv[++i]
    else if (a === '--expect-url') out.expectUrl = argv[++i]
    else if (a === '--runtime') out.runtime = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--self-test') out.selfTest = true
    else throw new Error('unknown argument: ' + a)
  }
  return out
}

/** Split a Dockerfile into instructions (continuations joined) and heredoc bodies. */
export function parseDockerfile(text) {
  const lines = text.split('\n')
  const instructions = [], heredocs = []
  let stage = null
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const start = i + 1
    while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1) + ' ' + lines[++i].trim()
    const [keyword, ...rest] = line.trim().split(/\s+/)
    const instruction = { keyword: keyword.toUpperCase(), args: rest.join(' '), line: start, stage }
    if (instruction.keyword === 'FROM') stage = instruction.stage = (rest.join(' ').match(/\bAS\s+(\S+)/i) ?? [])[1] ?? null
    instructions.push(instruction)
    const open = line.match(HEREDOC_OPEN)
    if (open) {
      const body = []
      while (++i < lines.length && lines[i] !== open[2]) body.push(lines[i])
      heredocs.push({ tag: open[2], target: instruction.args.split(/\s+/).at(-1), line: start, stage, body: body.join('\n') })
    }
  }
  return { instructions, heredocs }
}

export function checkSecretLiterals(name, text, fail) {
  text.split('\n').forEach((line, index) => {
    for (const [label, re] of SECRET_LITERALS) if (re.test(line)) fail(`${name}:${index + 1} contains a ${label}-shaped literal`)
  })
}

export function checkDockerfile(text, fail) {
  const { instructions, heredocs } = parseDockerfile(text)
  if (!/^# syntax=docker\/dockerfile:[0-9.]+@sha256:[0-9a-f]{64}\n/.test(text)) fail('Dockerfile:1: # syntax= frontend must be pinned by digest')
  const stages = new Set(instructions.filter(i => i.keyword === 'FROM').map(i => i.stage))
  for (const required of ['renderer', 'gateway']) if (!stages.has(required)) fail(`Dockerfile: missing target stage "${required}"`)
  const globalArgs = new Map(), seenStages = new Set()
  for (const ins of instructions) {
    const where = `Dockerfile:${ins.line}`
    if (ins.keyword === 'ARG' || ins.keyword === 'ENV') {
      const names = ins.keyword === 'ARG' ? [ins.args.split('=')[0].trim()]
        : /^[A-Za-z_][A-Za-z0-9_]*(\s|$)/.test(ins.args) ? [ins.args.split(/\s+/)[0]] // legacy "ENV KEY value"
          : [...ins.args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map(m => m[1])
      for (const n of names) if (CREDENTIAL_NAME.test(n) && !ALLOWED_CREDENTIAL_SHAPED_NAMES.has(n)) fail(`${where}: credential-named ${ins.keyword} ${n}`)
      if (ins.keyword === 'ARG' && /_IMAGE\b/.test(ins.args) && !/=\S+@sha256:[0-9a-f]{64}$/.test(ins.args)) fail(`${where}: base image not pinned by digest`)
      if (ins.keyword === 'ARG' && ins.stage === null && seenStages.size === 0) globalArgs.set(names[0], ins.args.includes('=') ? ins.args.slice(ins.args.indexOf('=') + 1) : '')
    }
    if (ins.keyword === 'FROM') {
      const ref = ins.args.split(/\s+/)[0]
      const arg = ref.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/)
      const ok = arg ? /@sha256:[0-9a-f]{64}$/.test(globalArgs.get(arg[1]) ?? '') : seenStages.has(ref) || /^[^$\s]+@sha256:[0-9a-f]{64}$/.test(ref)
      if (!ok) fail(`${where}: FROM must be a digest-pinned image, a global ARG whose default is digest-pinned, or an earlier stage`)
      if (ins.stage) seenStages.add(ins.stage)
    }
    if (/--mount=[^ ]*type=secret/.test(ins.args)) fail(`${where}: build secret mount`)
    if (ins.keyword === 'ADD' && !(/--checksum=sha256:[0-9a-f]{64}/.test(ins.args) && /\shttps:\/\/\S+\s+\S+$/.test(ins.args))) fail(`${where}: ADD only for a remote https file with --checksum`)
    if (ins.keyword === 'COPY') {
      const flags = ins.args.split(/\s+/).filter(t => t.startsWith('--'))
      const fromStage = flags.some(f => /^--from=[a-z][a-z0-9-]*$/.test(f) && seenStages.has(f.slice(7)))
      const heredoc = HEREDOC_OPEN.test(ins.args)
      if (!fromStage && !heredoc) fail(`${where}: COPY must come from an earlier stage or a heredoc (never the build context)`)
      if (flags.some(f => !/^--(from|chmod|link)(=|$)/.test(f))) fail(`${where}: unexpected COPY flag`)
    }
    if (ins.keyword === 'RUN' && /(huggingface-cli login|wrangler login|gh auth login|cloudflared (tunnel )?login)/.test(ins.args)) fail(`${where}: interactive credential login in image`)
  }
  const inStage = (stage, keyword) => instructions.filter(i => i.stage === stage && i.keyword === keyword)
  const env = stage => inStage(stage, 'ENV').map(i => i.args).join(' ')
  if (!/\bHF_HUB_OFFLINE=1\b/.test(env('renderer'))) fail('Dockerfile renderer: HF_HUB_OFFLINE=1 missing')
  for (const stage of ['renderer', 'gateway']) {
    const user = inStage(stage, 'USER').at(-1)?.args ?? ''
    if (!/^[1-9][0-9]*(:[1-9][0-9]*)?$/.test(user.trim())) fail(`Dockerfile ${stage}: must run as a numeric non-root USER`)
    const exposes = inStage(stage, 'EXPOSE').map(i => i.args.trim())
    const want = stage === 'renderer' ? '8998' : '8080'
    if (exposes.length !== 1 || exposes[0] !== want) fail(`Dockerfile ${stage}: must EXPOSE exactly ${want}`)
  }
  const entry = stage => inStage(stage, 'ENTRYPOINT').map(i => i.args.trim())
  if (JSON.stringify(entry('renderer')) !== JSON.stringify(['["/opt/voice/launch.sh"]'])) fail('Dockerfile renderer: ENTRYPOINT must be exactly ["/opt/voice/launch.sh"]')
  if (JSON.stringify(entry('gateway')) !== JSON.stringify(['["python", "/opt/gateway/gateway.py"]'])) fail('Dockerfile gateway: ENTRYPOINT must be exactly ["python", "/opt/gateway/gateway.py"]')
  for (const stage of ['renderer', 'gateway']) if (inStage(stage, 'CMD').length) fail(`Dockerfile ${stage}: no CMD`)
  const rendererIns = instructions.filter(i => i.stage === 'renderer')
  const userAt = rendererIns.findIndex(i => i.keyword === 'USER')
  if (!rendererIns.some((i, n) => n > userAt && i.keyword === 'RUN' && i.args.trim() === '["/opt/voice/launch.sh", "--check-env"]')) {
    fail('Dockerfile renderer: RUN ["/opt/voice/launch.sh", "--check-env"] must follow USER (build fails if the env would be refused)')
  }
  const byTarget = new Map(heredocs.map(h => [h.target, h]))
  for (const [target, digest] of Object.entries(PINNED_BODIES)) {
    const h = byTarget.get(target)
    if (!h) fail(`Dockerfile: pinned heredoc for ${target} missing`)
    else if (sha256(h.body) !== digest) fail(`Dockerfile:${h.line}: heredoc ${h.tag} -> ${target} differs from the reviewed body (sha256 ${sha256(h.body).slice(0, 12)}…); re-pin only in the same reviewed diff`)
  }
  for (const h of heredocs) if (!(h.target in PINNED_BODIES)) fail(`Dockerfile:${h.line}: unpinned heredoc ${h.tag} -> ${h.target}`)
  const doc = tag => heredocs.find(h => h.tag === tag)?.body ?? ''
  const launch = doc('LAUNCH')
  if (!/unexpected variable: \$name" >&2; exit 64/.test(launch) || !/credential-shaped value present" >&2; exit 64/.test(launch)
    || !/credential file present: \$f" >&2; exit 64/.test(launch)) {
    fail('Dockerfile LAUNCH: renderer credential refusal (allow-list, value scan, file scan) missing')
  }
  if (!/HF_HUB_OFFLINE must be 1/.test(launch)) fail('Dockerfile LAUNCH: offline enforcement missing')
  const gateway = doc('GATEWAY')
  if (!/hmac\.compare_digest/.test(gateway) || !/GATEWAY_TOKEN_SHA256/.test(gateway)) fail('Dockerfile GATEWAY: digest-only bearer check missing')
  if (!/"forced_text_stream":\s*\n\s*#[^\n]*\n\s*return deny\(501/.test(gateway)) fail('Dockerfile GATEWAY: forced_text_stream must always be refused with 501 on a stock renderer')
  const fetch = doc('FETCH')
  if (!/sys\.stdin\.read\(\)/.test(fetch) || /(os\.environ|getenv)[^\n]*HF_TOKEN\b/.test(fetch)) fail('Dockerfile FETCH: HF token must come from stdin only')
  return { instructions: instructions.length, heredocs: heredocs.map(h => h.tag) }
}

export function checkCloudflaredConfig(text, { name, expectHost, allowPlaceholders, team = null }, fail) {
  let doc
  try { doc = yaml.load(text) } catch (error) { fail(`${name}: invalid YAML (${error.reason ?? error.message})`); return }
  if (!doc || typeof doc !== 'object') { fail(`${name}: empty config`); return }
  const placeholder = v => typeof v === 'string' && /<[A-Z_]+>/.test(v)
  if (!allowPlaceholders && /<[A-Z_]+>/.test(text)) fail(`${name}: unfilled <PLACEHOLDER> values`)
  for (const key of ['token', 'TunnelSecret', 'tunnel-token', 'origincert', 'cert']) if (key in doc) fail(`${name}: inline credential key "${key}"`)
  if (doc.originRequest?.access) fail(`${name}: top-level originRequest.access is silently ignored by cloudflared; put it under the ingress rule`)
  if (doc.originRequest?.noTLSVerify === true) fail(`${name}: top-level noTLSVerify`)
  if (doc['credentials-file'] !== '/etc/cloudflared/credentials.json') fail(`${name}: credentials-file must be the mounted /etc/cloudflared/credentials.json`)
  if (doc.metrics !== undefined && !/^127\.0\.0\.1:\d+$/.test(String(doc.metrics))) fail(`${name}: metrics must bind 127.0.0.1`)
  if (doc['warp-routing']?.enabled) fail(`${name}: warp-routing must be off`)
  const ingress = doc.ingress
  if (!Array.isArray(ingress) || ingress.length !== 2) { fail(`${name}: ingress must be exactly [voice rule, catch-all 404]`); return }
  const [rule, last] = ingress
  if (rule.hostname !== expectHost) fail(`${name}: ingress hostname must be ${expectHost} (the Worker's PERSONAPLEX_WS_URL host), got ${JSON.stringify(rule.hostname)}`)
  if (rule.path !== '^/api/chat$') fail(`${name}: ingress path must be exactly ^/api/chat$`)
  if (rule.service !== 'http://gateway:8080') fail(`${name}: ingress service must be http://gateway:8080 (never the renderer, never tcp/ssh/unix/hello_world)`)
  const origin = rule.originRequest ?? {}
  if (origin.noTLSVerify === true) fail(`${name}: noTLSVerify on the voice rule`)
  if (origin.proxyType) fail(`${name}: proxyType on the voice rule`)
  const access = origin.access
  if (!access || access.required !== true) fail(`${name}: originRequest.access.required: true must sit under the voice rule`)
  else {
    if (!access.teamName || (!allowPlaceholders && placeholder(access.teamName))) fail(`${name}: access.teamName missing`)
    if (!Array.isArray(access.audTag) || access.audTag.length !== 1 || !access.audTag[0]) fail(`${name}: access.audTag must name exactly one Access application`)
    else if (!allowPlaceholders && !/^[0-9a-f]{64}$/.test(String(access.audTag[0]))) fail(`${name}: access.audTag must be a 64-hex Access application AUD`)
    if (team !== null && access.teamName !== team) fail(`${name}: access.teamName must be ${team}`)
  }
  if (!last || last.service !== 'http_status:404' || last.hostname || last.path || Object.keys(last).length !== 1) fail(`${name}: last ingress rule must be exactly { service: http_status:404 }`)
}

export function readmeComposeBlock(text, fail) {
  const match = text.match(/### `\/etc\/aukora\/voice-compose\.yaml`\s*\n+```yaml\n([\s\S]*?)\n```/)
  if (!match) { fail('README.md: compose block missing'); return null }
  return match[1]
}

/** Strict check of a compose file: the README block, and (--compose) the deployed copy. */
export function checkCompose(text, name, fail) {
  let doc
  try { doc = yaml.load(text) } catch (error) { fail(`${name}: invalid YAML ${error.reason ?? error.message}`); return }
  if (!doc || typeof doc !== 'object') { fail(`${name}: empty compose file`); return }
  for (const key of Object.keys(doc)) if (!['name', 'services', 'networks', 'volumes'].includes(key)) fail(`${name}: unexpected top-level key ${key}`)
  const services = doc.services ?? {}
  const nets = doc.networks ?? {}
  if (!same(Object.keys(services), Object.keys(SERVICE_KEYS))) fail(`${name}: services must be exactly ${Object.keys(SERVICE_KEYS)}, got ${Object.keys(services)}`)
  if (!same(Object.keys(nets), ['egress_net', 'renderer_net', 'tunnel_net'])) fail(`${name}: networks must be exactly egress_net, renderer_net, tunnel_net`)
  for (const net of ['renderer_net', 'tunnel_net']) if (nets[net]?.internal !== true) fail(`${name}: ${net} must be internal: true`)
  for (const [svcName, svc] of Object.entries(services)) {
    const where = `${name} ${svcName}`
    if (!svc || typeof svc !== 'object') { fail(`${where}: not a mapping`); continue }
    const allowed = SERVICE_KEYS[svcName] ?? []
    for (const key of Object.keys(svc)) if (!allowed.includes(key)) fail(`${where}: key "${key}" not allowed (entrypoint, command, user, ports, privileged, env_file, secrets, extra mounts are all refused)`)
    if (svc.read_only !== true || !same(svc.cap_drop, ['ALL'])) fail(`${where}: read_only: true and cap_drop: [ALL] required`)
    if (!(svc.security_opt ?? []).includes('no-new-privileges:true')) fail(`${where}: security_opt no-new-privileges:true required`)
    if (!same(svc.networks, SERVICE_NETWORKS[svcName] ?? [])) fail(`${where}: networks must be exactly ${SERVICE_NETWORKS[svcName]}`)
    for (const key of Object.keys(svc.environment ?? {})) {
      if (CREDENTIAL_NAME.test(key) && !ALLOWED_CREDENTIAL_SHAPED_NAMES.has(key)) fail(`${where}: credential-named env ${key}`)
    }
  }
  const renderer = services.renderer, gateway = services.gateway, cf = services.cloudflared
  if (renderer) {
    if (!/^aukora-voice-renderer[:@]/.test(String(renderer.image))) fail(`${name} renderer: image must be aukora-voice-renderer`)
    if (!same(renderer.volumes, RENDERER_VOLUMES)) fail(`${name} renderer: volumes must be exactly ${RENDERER_VOLUMES.join(', ')}`)
  }
  if (gateway) {
    if (!/^aukora-voice-gateway[:@]/.test(String(gateway.image))) fail(`${name} gateway: image must be aukora-voice-gateway`)
    const env = gateway.environment ?? {}
    if (Array.isArray(env)) fail(`${name} gateway: environment must be a mapping`)
    else {
      if (!same(Object.keys(env), ['GATEWAY_TOKEN_SHA256', 'PERSONAPLEX_ALLOW_FREE_RENDER', 'PERSONAPLEX_UPSTREAM'])) fail(`${name} gateway: environment keys must be exactly GATEWAY_TOKEN_SHA256, PERSONAPLEX_UPSTREAM, PERSONAPLEX_ALLOW_FREE_RENDER`)
      if (!/^\$\{GATEWAY_TOKEN_SHA256(:\?[^}]*)?\}$|^[0-9a-f]{64}(,[0-9a-f]{64}){0,3}$/.test(String(env.GATEWAY_TOKEN_SHA256))) fail(`${name} gateway: GATEWAY_TOKEN_SHA256 must be digest(s) or the \${GATEWAY_TOKEN_SHA256} interpolation`)
      if (env.PERSONAPLEX_UPSTREAM !== 'ws://renderer:8998/api/chat') fail(`${name} gateway: PERSONAPLEX_UPSTREAM must be ws://renderer:8998/api/chat`)
      if (env.PERSONAPLEX_ALLOW_FREE_RENDER !== '0') fail(`${name} gateway: production must keep PERSONAPLEX_ALLOW_FREE_RENDER "0"`)
    }
  }
  if (cf) {
    if (!/^cloudflare\/cloudflared:[^@\s]+@sha256:[0-9a-f]{64}$/.test(String(cf.image))) fail(`${name} cloudflared: image must be cloudflare/cloudflared pinned by digest`)
    const command = Array.isArray(cf.command) ? cf.command.map(String) : []
    if (!Array.isArray(cf.command) || command.at(-1) !== 'run' || !command.join(' ').includes('--metrics 127.0.0.1:') || !command.join(' ').includes('--config /etc/cloudflared/config.yml')
      || command.some(t => /^--(token|token-file|credentials-contents|url|hello-world)\b/.test(t))) {
      fail(`${name} cloudflared: command must be "tunnel ... --metrics 127.0.0.1:N --config /etc/cloudflared/config.yml run" (no --token/--url/--hello-world)`)
    }
    if (!same(cf.volumes, CLOUDFLARED_VOLUMES)) fail(`${name} cloudflared: volumes must be exactly the config and the tunnel credentials file`)
  }
}

export function checkEnvFile(text, fail) {
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) return fail(`env-file:${index + 1}: unparsable line`)
    const [, key, value] = m
    if (!ENV_FILE_KEYS.has(key)) return fail(`env-file:${index + 1}: unexpected key ${key} (allowed: ${[...ENV_FILE_KEYS]})`)
    if (key === 'GATEWAY_TOKEN_SHA256' && !/^[0-9a-f]{64}(,[0-9a-f]{64}){0,3}$/.test(value)) fail(`env-file:${index + 1}: GATEWAY_TOKEN_SHA256 must be 64-hex digest(s), never the token`)
    if (key === 'PERSONAPLEX_ALLOW_FREE_RENDER' && value !== '0') fail(`env-file:${index + 1}: production keeps PERSONAPLEX_ALLOW_FREE_RENDER=0`)
  })
}

export function checkRuntime(container, fail) {
  let info
  try { info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0] } catch (error) { fail(`runtime: docker inspect ${container} failed (${error.code ?? 'error'})`); return }
  for (const entry of info.Config?.Env ?? []) {
    const key = entry.split('=')[0]
    if (CREDENTIAL_NAME.test(key) && !ALLOWED_CREDENTIAL_SHAPED_NAMES.has(key)) fail(`runtime ${container}: credential-named env ${key}`)
    for (const [label, re] of SECRET_LITERALS) if (re.test(entry)) fail(`runtime ${container}: ${label}-shaped env value in ${key}`)
  }
  const mounts = info.Mounts ?? []
  if (!same(mounts.map(m => m.Destination), ['/etc/voice-pin', '/models'])) fail(`runtime ${container}: mounts must be exactly /models and /etc/voice-pin, got ${mounts.map(m => m.Destination)}`)
  for (const mount of mounts) if (mount.RW) fail(`runtime ${container}: mount ${mount.Destination} must be read-only`)
  if (JSON.stringify(info.Config?.Entrypoint) !== '["/opt/voice/launch.sh"]') fail(`runtime ${container}: entrypoint must be /opt/voice/launch.sh`)
  if ((info.Config?.Cmd ?? []).length) fail(`runtime ${container}: no command arguments`)
  if (info.Config?.User !== '10001:10001') fail(`runtime ${container}: must run as 10001:10001`)
  if (info.HostConfig?.ReadonlyRootfs !== true) fail(`runtime ${container}: read-only root filesystem required`)
  const networks = Object.keys(info.NetworkSettings?.Networks ?? {})
  if (networks.length !== 1 || !/(^|_)renderer_net$/.test(networks[0])) fail(`runtime ${container}: must be on renderer_net only, got ${networks}`)
  if (Object.keys(info.NetworkSettings?.Ports ?? {}).some(p => (info.NetworkSettings.Ports[p] ?? []).length)) fail(`runtime ${container}: published ports`)
  if (info.HostConfig?.Privileged) fail(`runtime ${container}: privileged`)
  try {
    execFileSync('docker', ['exec', container, 'sh', '-c', 'test ! -e /models/token && test ! -e /run/secrets && test ! -e "$HOME/.cache/huggingface/token"'])
  } catch { fail(`runtime ${container}: a credential file exists inside the container`) }
}

function run(opts, files) {
  const failures = []
  const fail = message => failures.push(message)
  const read = name => files[name] ?? readFileSync(join(HERE, name), 'utf8')
  for (const name of ['Dockerfile', 'cloudflared-config.example.yml', 'README.md', 'verify-personaplex-zero-secret.mjs']) {
    if (name !== 'verify-personaplex-zero-secret.mjs') checkSecretLiterals(name, read(name), fail)
  }
  const expectHost = new URL(opts.expectUrl).hostname
  const summary = { dockerfile: checkDockerfile(read('Dockerfile'), fail) }
  checkCloudflaredConfig(read('cloudflared-config.example.yml'), { name: 'cloudflared-config.example.yml', expectHost, allowPlaceholders: true }, fail)
  const block = readmeComposeBlock(read('README.md'), fail)
  if (block !== null) checkCompose(block, 'README compose', fail)
  if (opts.config) {
    const text = files[opts.config] ?? readFileSync(opts.config, 'utf8')
    checkSecretLiterals(opts.config, text, fail)
    checkCloudflaredConfig(text, { name: opts.config, expectHost, allowPlaceholders: false, team: opts.team ?? null }, fail)
  }
  if (opts.compose) {
    const text = files[opts.compose] ?? readFileSync(opts.compose, 'utf8')
    checkSecretLiterals(opts.compose, text, fail)
    checkCompose(text, opts.compose, fail)
  }
  if (opts.envFile) checkEnvFile(files[opts.envFile] ?? readFileSync(opts.envFile, 'utf8'), fail)
  if (opts.runtime) checkRuntime(opts.runtime, fail)
  return { ok: failures.length === 0, failures, summary }
}

function selfTest() {
  const base = Object.fromEntries(['Dockerfile', 'cloudflared-config.example.yml', 'README.md'].map(n => [n, readFileSync(join(HERE, n), 'utf8')]))
  const opts = { expectUrl: 'wss://voice.example.invalid/api/chat' }
  const filled = base['cloudflared-config.example.yml'].replace('<TUNNEL_UUID>', '5e000003-0000-4000-8000-000000000003')
    .replace('<ZERO_TRUST_TEAM_NAME>', 'example-team').replace('<ACCESS_APPLICATION_AUD_TAG>', 'a'.repeat(64))
  const composeBlock = readmeComposeBlock(base['README.md'], () => {}) ?? ''
  const cases = [
    ['baseline passes', {}, null, true],
    ['filled config passes', { 'cfg.yml': filled }, { config: 'cfg.yml' }, true],
    ['unfilled config rejected', { 'cfg.yml': base['cloudflared-config.example.yml'] }, { config: 'cfg.yml' }, false],
    ['top-level access rejected', { 'cfg.yml': filled.replace('ingress:', 'originRequest:\n  access:\n    required: true\ningress:') }, { config: 'cfg.yml' }, false],
    ['access under rule removed', { 'cfg.yml': filled.replace(/      access:\n(        .*\n)+?(?=  - service)/, '') }, { config: 'cfg.yml' }, false],
    ['access not required', { 'cfg.yml': filled.replace('required: true', 'required: false') }, { config: 'cfg.yml' }, false],
    ['wildcard host', { 'cfg.yml': filled.replace('hostname: voice.example.invalid', 'hostname: "*.example.invalid"') }, { config: 'cfg.yml' }, false],
    ['other host', { 'cfg.yml': filled.replace('hostname: voice.example.invalid', 'hostname: voice.evil.example') }, { config: 'cfg.yml' }, false],
    ['extra ingress rule', { 'cfg.yml': filled.replace('  - service: http_status:404', '  - hostname: ssh.example.invalid\n    service: ssh://localhost:22\n  - service: http_status:404') }, { config: 'cfg.yml' }, false],
    ['direct to renderer', { 'cfg.yml': filled.replace('service: http://gateway:8080', 'service: http://renderer:8998') }, { config: 'cfg.yml' }, false],
    ['no catch-all', { 'cfg.yml': filled.replace('  - service: http_status:404', '  - service: http://gateway:8080') }, { config: 'cfg.yml' }, false],
    ['path widened', { 'cfg.yml': filled.replace('path: ^/api/chat$', 'path: ^/api') }, { config: 'cfg.yml' }, false],
    ['inline tunnel token', { 'cfg.yml': filled + 'token: abc\n' }, { config: 'cfg.yml' }, false],
    ['credential ENV in Dockerfile', { Dockerfile: base.Dockerfile.replace('    HF_HUB_OFFLINE=1 \\', '    HF_HUB_OFFLINE=1 \\\n    HF_TOKEN=placeholder \\') }, null, false],
    ['secret literal in Dockerfile', { Dockerfile: base.Dockerfile + '\n# hf_' + 'A'.repeat(34) + '\n' }, null, false],
    ['build secret mount', { Dockerfile: base.Dockerfile.replace('RUN uv venv', 'RUN --mount=type=secret,id=hf uv venv') }, null, false],
    ['renderer offline removed', { Dockerfile: base.Dockerfile.replace('    HF_HUB_OFFLINE=1 \\\n', '') }, null, false],
    ['renderer as root', { Dockerfile: base.Dockerfile.replace('USER 10001:10001', 'USER root') }, null, false],
    ['unpinned base image', { Dockerfile: base.Dockerfile.replace(/(ARG PYTHON_IMAGE=python:3\.12-slim-bookworm)@sha256:[0-9a-f]{64}/, '$1') }, null, false],
    ['unchecked remote ADD', { Dockerfile: base.Dockerfile.replace(/ADD --checksum=sha256:[0-9a-f]{64} \\\n/, 'ADD \\\n') }, null, false],
    ['launch value scan removed', { Dockerfile: base.Dockerfile.replace('credential-shaped value present" >&2; exit 64', 'credential-shaped value present" >&2') }, null, false],
    ['launch refusal removed', { Dockerfile: base.Dockerfile.replaceAll('unexpected variable', 'variable') }, null, false],
    ['forced text accepted', { Dockerfile: base.Dockerfile.replace('return deny(501, "VOICE_FORCED_TEXT_STREAM_UNAVAILABLE")', 'pass') }, null, false],
    ['renderer port published', { 'README.md': base['README.md'].replace('    networks: [renderer_net]\n', '    networks: [renderer_net]\n    ports: ["8998:8998"]\n') }, null, false],
    ['renderer env credential', { 'README.md': base['README.md'].replace('    networks: [renderer_net]\n', '    networks: [renderer_net]\n    environment: { HF_TOKEN: x }\n') }, null, false],
    ['free render in prod', { 'README.md': base['README.md'].replace('PERSONAPLEX_ALLOW_FREE_RENDER: "0"', 'PERSONAPLEX_ALLOW_FREE_RENDER: "1"') }, null, false],
    ['env file with plaintext token', { 'e.env': 'GATEWAY_TOKEN_SHA256=' + 'Z'.repeat(64) + '\n' }, { envFile: 'e.env' }, false],
    ['env file extra key', { 'e.env': 'GATEWAY_TOKEN_SHA256=' + 'a'.repeat(64) + '\nPERSONAPLEX_AUTH_TOKEN=x\n' }, { envFile: 'e.env' }, false],
    ['FROM bare image', { Dockerfile: base.Dockerfile.replace('FROM ${CUDA_IMAGE} AS renderer\n', 'FROM ubuntu AS renderer\n') }, null, false],
    ['FROM via undigested ARG', { Dockerfile: base.Dockerfile.replace('FROM ${PYTHON_IMAGE} AS gateway-base', 'ARG BASE=ubuntu:latest\nFROM ${BASE} AS gateway-base') }, null, false],
    ['image ARG without default', { Dockerfile: base.Dockerfile.replace(/ARG CUDA_IMAGE=\S+/, 'ARG CUDA_IMAGE') }, null, false],
    ['legacy ENV credential', { Dockerfile: base.Dockerfile.replace('USER 10002:10002', 'ENV CF_API_TOKEN abc\nUSER 10002:10002') }, null, false],
    ['USER 00', { Dockerfile: base.Dockerfile.replace('USER 10002:10002', 'USER 00') }, null, false],
    ['named USER', { Dockerfile: base.Dockerfile.replace('USER 10001:10001', 'USER voice') }, null, false],
    ['COPY build context', { Dockerfile: base.Dockerfile.replace('USER 10002:10002', 'COPY . /opt/ctx\nUSER 10002:10002') }, null, false],
    ['ADD local file', { Dockerfile: base.Dockerfile.replace('USER 10002:10002', 'ADD secrets.tgz /opt/\nUSER 10002:10002') }, null, false],
    ['entrypoint bypasses launch.sh', { Dockerfile: base.Dockerfile.replace('ENTRYPOINT ["/opt/voice/launch.sh"]', 'ENTRYPOINT ["sh","-c","exec python -m moshi.server # launch.sh"]') }, null, false],
    ['renderer CMD added', { Dockerfile: base.Dockerfile.replace('ENTRYPOINT ["/opt/voice/launch.sh"]', 'ENTRYPOINT ["/opt/voice/launch.sh"]\nCMD ["--check-env"]') }, null, false],
    ['check-env build step removed', { Dockerfile: base.Dockerfile.replace('RUN ["/opt/voice/launch.sh", "--check-env"]\n', '') }, null, false],
    ['launch allow-list widened', { Dockerfile: base.Dockerfile.replace('NCCL_VERSION|NVIDIA_*|NV_*) ;;', 'NCCL_VERSION|NVIDIA_*|NV_*|*) ;;') }, null, false],
    ['forced text short-circuited', { Dockerfile: base.Dockerfile.replace('if params["mode"] == "forced_text_stream":', 'if False and params["mode"] == "forced_text_stream":') }, null, false],
    ['fetch token from env', { Dockerfile: base.Dockerfile.replace('token = sys.stdin.read().strip()', 'token = os.getenv("HF_" + "TOKEN") or sys.stdin.read().strip()') }, null, false],
    ['gateway pins edited', { Dockerfile: base.Dockerfile.replace(/^aiohttp==3\.14\.5 /m, 'aiohttp==3.14.4 ') }, null, false],
    ['syntax frontend unpinned', { Dockerfile: base.Dockerfile.replace(/^# syntax=docker\/dockerfile:1\.7@sha256:[0-9a-f]{64}/, '# syntax=docker/dockerfile:1.7') }, null, false],
    ['compose renderer entrypoint', { 'README.md': base['README.md'].replace('    networks: [renderer_net]\n', '    networks: [renderer_net]\n    entrypoint: ["python", "-m", "moshi.server"]\n') }, null, false],
    ['compose renderer root', { 'README.md': base['README.md'].replace('    networks: [renderer_net]\n', '    networks: [renderer_net]\n    user: "0:0"\n') }, null, false],
    ['compose renderer extra mount', { 'README.md': base['README.md'].replace('"/etc/aukora/voice-pin:/etc/voice-pin:ro"]', '"/etc/aukora/voice-pin:/etc/voice-pin:ro", "/home/op/.secrets:/s:ro"]') }, null, false],
    ['compose pin mount removed', { 'README.md': base['README.md'].replace(', "/etc/aukora/voice-pin:/etc/voice-pin:ro"]', ']') }, null, false],
    ['compose fourth service bridges renderer_net', { 'README.md': base['README.md'].replace('networks:\n  renderer_net:', '  x: { image: alpine/socat, read_only: true, cap_drop: [ALL], networks: [renderer_net, egress_net] }\nnetworks:\n  renderer_net:') }, null, false],
    ['compose cloudflared on renderer_net', { 'README.md': base['README.md'].replace('networks: [tunnel_net, egress_net]', 'networks: [tunnel_net, egress_net, renderer_net]') }, null, false],
    ['compose cloudflared --token', { 'README.md': base['README.md'].replace('"--config", "/etc/cloudflared/config.yml", "run"]', '"--config", "/etc/cloudflared/config.yml", "--token", "x", "run"]') }, null, false],
    ['compose gateway extra env', { 'README.md': base['README.md'].replace('      PERSONAPLEX_ALLOW_FREE_RENDER: "0"\n', '      PERSONAPLEX_ALLOW_FREE_RENDER: "0"\n      DEBUG: "1"\n') }, null, false],
    ['compose gateway upstream elsewhere', { 'README.md': base['README.md'].replace('PERSONAPLEX_UPSTREAM: ws://renderer:8998/api/chat', 'PERSONAPLEX_UPSTREAM: ws://evil:8998/api/chat') }, null, false],
    ['deployed compose ok', { 'c.yaml': composeBlock }, { compose: 'c.yaml' }, true],
    ['deployed compose renderer root', { 'c.yaml': composeBlock.replace('    networks: [renderer_net]\n', '    networks: [renderer_net]\n    user: "0:0"\n') }, { compose: 'c.yaml' }, false],
    ['audTag not 64-hex', { 'cfg.yml': filled.replace('a'.repeat(64), 'my-app') }, { config: 'cfg.yml' }, false],
    ['team mismatch', { 'cfg.yml': filled }, { config: 'cfg.yml', team: 'someone-else' }, false],
    ['team match', { 'cfg.yml': filled }, { config: 'cfg.yml', team: 'example-team' }, true],
    ['env file ok', { 'e.env': 'GATEWAY_TOKEN_SHA256=' + 'a'.repeat(64) + '\nPERSONAPLEX_ALLOW_FREE_RENDER=0\n' }, { envFile: 'e.env' }, true],
  ]
  let bad = 0
  for (const [label, files, extra, expectOk] of cases) {
    const result = run({ ...opts, ...(extra ?? {}) }, { ...base, ...files })
    const pass = result.ok === expectOk
    if (!pass) bad++
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : ' -> ' + JSON.stringify(result.failures)}`)
  }
  console.log(`self-test: ${cases.length - bad}/${cases.length}`)
  return bad === 0
}

const opts = parseArgs(process.argv.slice(2))
if (opts.selfTest) process.exit(selfTest() ? 0 : 1)
const result = run(opts, {})
if (opts.json) console.log(JSON.stringify(result, null, 2))
else if (result.ok) console.log('PERSONAPLEX zero-secret ok ' + JSON.stringify({ heredocs: result.summary.dockerfile.heredocs, config: opts.config ?? 'example', runtime: opts.runtime ?? 'not checked' }))
else console.error('PERSONAPLEX zero-secret FAILED\n- ' + result.failures.join('\n- '))
process.exit(result.ok ? 0 : 1)
