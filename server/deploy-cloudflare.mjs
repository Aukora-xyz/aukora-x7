/**
 * Print the fixed production deployment command; only an explicit --deploy starts Wrangler.
 *
 * ONE PUBLISHER: once the GitHub environment `production` holds its Cloudflare secrets, GitHub Actions
 * (.github/workflows/deploy-x61.yml) is the one publisher and this local script is for emergencies only. Before deploying it
 * asks `gh` for the NAMES of the repository's environments and of that environment's secrets (never values); when both
 * credential names are listed it prints that sentence and refuses unless --emergency is given too. When GitHub cannot be
 * asked at all (gh not installed or not on PATH, expired auth, no access, network), it prints the sentence with the reason
 * and refuses unless --emergency is given: a silent second publisher is the fault (review loop3 S3: a missing gh is unknown,
 * not absent). It deploys without --emergency only when GitHub answers that the cloud publisher is not configured.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { devNull } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(repository, 'deploy/cloudflare/wrangler.toml')
const workerName = 'your-node'
const flags = Object.freeze(['global_fetch_strictly_public', 'no_cots_on_external_fetch'])
const refuse = code => { throw new Error(code) }
const repositorySlug = 'your_org_x/your-node'
const cloudCredentialNames = Object.freeze(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])
export const ONE_PUBLISHER_NOTICE = 'ONE PUBLISHER: the production environment holds its Cloudflare secrets, so GitHub Actions (deploy-x61.yml) publishes node.example.invalid when it runs (manual dispatch only until its push trigger is re-enabled); this Mac script is for emergencies only (--deploy --emergency).'

export const ONE_PUBLISHER_UNKNOWN_NOTICE = 'ONE PUBLISHER: GitHub could not be asked whether the production environment holds its Cloudflare secrets; if it does, GitHub Actions (deploy-x61.yml) publishes node.example.invalid when it runs (manual dispatch only until its push trigger is re-enabled) and this Mac script is for emergencies only (--deploy --emergency).'

/**
 * Whether the cloud publisher is switched on: the repository has an environment `production` and its secrets listing
 * names both credentials. Names only, never values.
 * @returns {{ state: 'configured'|'not-configured'|'unknown', reason?: string }} unknown: gh is missing or could not answer
 *   (refuse unless --emergency).
 */
export function cloudPublisherState(ghProcess = spawnSync) {
  const ask = args => ghProcess('gh', ['api', ...args], { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })
  const names = result => new Set(result.stdout.split('\n').map(line => line.trim()).filter(Boolean))
  const failure = result => {
    if (result?.error) return { state: 'unknown', reason: `gh failed: ${/^[A-Z0-9_]{1,32}$/.test(String(result.error.code)) ? result.error.code : 'error'}` }
    if (!result || result.status !== 0 || typeof result.stdout !== 'string') return { state: 'unknown', reason: `gh exited ${Number.isInteger(result?.status) ? result.status : 'abnormally'}` }
    return null
  }
  // A repository without the environment yet answers 404 on the secrets listing; the environments listing tells that
  // apart from a repository gh cannot see.
  const environments = ask([`repos/${repositorySlug}/environments?per_page=100`, '--jq', '.environments[].name'])
  const environmentsFailed = failure(environments)
  if (environmentsFailed) return environmentsFailed
  if (!names(environments).has('production')) return { state: 'not-configured' }
  const secrets = ask([`repos/${repositorySlug}/environments/production/secrets`, '--jq', '.secrets[].name'])
  const secretsFailed = failure(secrets)
  if (secretsFailed) return secretsFailed
  const listed = names(secrets)
  return { state: cloudCredentialNames.every(name => listed.has(name)) ? 'configured' : 'not-configured' }
}

/**
 * Validate production-only arguments without starting a process or loading credentials.
 * @param {string[]} argv No arguments, --print, --deploy, or --deploy --emergency; anything else is refused.
 * @param {object} config Parsed canonical Wrangler configuration.
 * @param {object} environment Ambient variables checked for conflicting deployment targets.
 * @returns {object} Fixed command, arguments, working directory, and explicit execution choice.
 */
export function cloudflareDeploymentPlan(argv, config, environment = {}) {
  const emergency = Array.isArray(argv) && argv.length === 2 && argv[0] === '--deploy' && argv[1] === '--emergency'
  if (!Array.isArray(argv) || !emergency && (argv.length > 1 || argv.length === 1 && !['--print', '--deploy'].includes(argv[0]))) refuse('DEPLOY_ARGUMENTS_REFUSED')
  if (config?.name !== workerName || typeof config.account_id !== 'string' || !/^[a-f0-9]{32}$/.test(config.account_id)) refuse('DEPLOY_TARGET_INVALID')
  if (Object.hasOwn(environment, 'CLOUDFLARE_ENV')) refuse('DEPLOY_ENVIRONMENT_OVERRIDE_REFUSED')
  if (Object.hasOwn(environment, 'WRANGLER_CI_OVERRIDE_NAME') && environment.WRANGLER_CI_OVERRIDE_NAME !== config.name) refuse('DEPLOY_NAME_OVERRIDE_REFUSED')
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID']) {
    if (Object.hasOwn(environment, name) && environment[name] !== config.account_id) refuse('DEPLOY_ACCOUNT_OVERRIDE_REFUSED')
  }
  for (const name of ['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL']) {
    if (Object.hasOwn(environment, name)) refuse('DEPLOY_API_OVERRIDE_REFUSED')
  }
  if (Object.hasOwn(environment, 'WRANGLER_API_ENVIRONMENT') && environment.WRANGLER_API_ENVIRONMENT !== 'production') refuse('DEPLOY_API_OVERRIDE_REFUSED')
  if (Object.hasOwn(environment, 'CLOUDFLARE_COMPLIANCE_REGION') && environment.CLOUDFLARE_COMPLIANCE_REGION !== 'public') refuse('DEPLOY_API_OVERRIDE_REFUSED')
  if (config.compliance_region !== undefined && config.compliance_region !== 'public') refuse('DEPLOY_API_OVERRIDE_REFUSED')
  // Wrangler's CLI array replaces config flags. Do not silently drop a future policy.
  if (config.compatibility_flags !== undefined && (!Array.isArray(config.compatibility_flags) || config.compatibility_flags.length !== 0)) refuse('DEPLOY_CONFIG_FLAGS_REFUSED')
  // A fixed empty env file prevents Wrangler from loading unchecked .env overrides later.
  return { command: 'npx', args: ['--yes', 'wrangler@4.159.0', 'deploy', '--config', configPath, '--env-file', devNull,
    ...flags.flatMap(flag => ['--compatibility-flags', flag])], cwd: repository, deploy: argv[0] === '--deploy', emergency }
}

/**
 * Read only the canonical config and print by default; deploying requires --deploy.
 * @param {string[]} argv Explicit entrypoint arguments, never forwarded to Wrangler.
 * @param {object} options Injectable process and output functions for offline tests.
 * @returns {number} Zero for a printed plan, or the completed deployment process status.
 */
export function runCloudflareDeployment(argv, { environment = process.env, spawnProcess = spawnSync, ghProcess = spawnSync, output = console.log } = {}) {
  const config = parse(readFileSync(configPath, 'utf8'))
  const plan = cloudflareDeploymentPlan(argv, config, environment)
  if (!plan.deploy) {
    output(JSON.stringify({ ...plan, notice: 'PRINT ONLY: no build, upload, or deployment ran. Use --deploy only with production deployment authorization.' }))
    return 0
  }
  const publisher = cloudPublisherState(ghProcess)
  if (publisher.state === 'configured') {
    output(ONE_PUBLISHER_NOTICE)
    if (!plan.emergency) refuse('DEPLOY_CLOUD_PUBLISHER_ACTIVE')
  }
  if (publisher.state === 'unknown') {
    output(`${ONE_PUBLISHER_UNKNOWN_NOTICE} Reason: ${publisher.reason}.`)
    if (!plan.emergency) refuse('DEPLOY_CLOUD_PUBLISHER_UNKNOWN')
  }
  const result = spawnProcess(plan.command, plan.args, { cwd: plan.cwd, env: environment, stdio: 'inherit', shell: false })
  if (result.error || result.signal || !Number.isInteger(result.status)) refuse('DEPLOY_PROCESS_FAILED')
  return result.status
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runCloudflareDeployment(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error && /^DEPLOY_[A-Z_]+$/.test(error.message) ? error.message : 'DEPLOY_CONFIG_UNREADABLE'); process.exitCode = 1 }
}
