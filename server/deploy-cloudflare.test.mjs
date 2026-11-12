/** Synthetic deployment plans and injected process calls only; no Wrangler execution or network. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { devNull } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'
import { cloudflareDeploymentPlan, cloudPublisherState, runCloudflareDeployment, ONE_PUBLISHER_NOTICE, ONE_PUBLISHER_UNKNOWN_NOTICE } from './deploy-cloudflare.mjs'
import { platformPublicHttpsAvailable } from '../deploy/cloudflare/src/public-https-transport.mjs'

const config = parse(readFileSync(new URL('../deploy/cloudflare/wrangler.toml', import.meta.url), 'utf8'))
const flags = ['global_fetch_strictly_public', 'no_cots_on_external_fetch']
/** `gh` is not installed or not on PATH: GitHub cannot be asked, so the deploy needs --emergency (review loop3 S3). */
const noGh = () => ({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) })
const ENVIRONMENTS = ['api', 'repos/your_org_x/your-node/environments?per_page=100', '--jq', '.environments[].name']
const SECRETS = ['api', 'repos/your_org_x/your-node/environments/production/secrets', '--jq', '.secrets[].name']
/** GitHub as `gh` answers it: the repository's environments, then the production environment's secret NAMES. */
const ghListing = (names, environments = ['production']) => (command, args) => {
  const listed = JSON.stringify(args) === JSON.stringify(ENVIRONMENTS) ? environments : JSON.stringify(args) === JSON.stringify(SECRETS) ? names : null
  return listed ? { status: 0, signal: null, stdout: listed.map(name => name + '\n').join('') } : { status: 1, signal: null, stdout: '' }
}
/** GitHub answers that the repository has no production environment yet: the cloud publisher is not switched on. */
const notConfigured = ghListing([], [])

test('canonical local config has no general public fetch flags', t => {
  assert.equal(config.compatibility_flags, undefined)
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'Cloudflare')
  Object.defineProperty(globalThis, 'Cloudflare', { configurable: true, value: { compatibilityFlags: { global_fetch_strictly_public: false, no_cots_on_external_fetch: true } } })
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'Cloudflare', saved); else delete globalThis.Cloudflare })
  assert.equal(platformPublicHttpsAvailable(), false)
})

test('default and print-only entrypoints never start a process', () => {
  for (const argv of [[], ['--print']]) {
    const lines = []
    assert.equal(runCloudflareDeployment(argv, { environment: {}, output: value => lines.push(value), spawnProcess: () => assert.fail('Must not deploy') }), 0)
    assert.equal(lines.length, 1)
    const printed = JSON.parse(lines[0])
    assert.equal(printed.deploy, false)
    assert.match(printed.notice, /^PRINT ONLY:/)
  }
})

test('explicit deployment constructs only fixed production argv and uses canonical unmodified config', () => {
  const before = readFileSync(new URL('../deploy/cloudflare/wrangler.toml', import.meta.url), 'utf8')
  const environment = {}, calls = []
  assert.equal(runCloudflareDeployment(['--deploy'], { environment, ghProcess: notConfigured, output: () => assert.fail('Unexpected output'), spawnProcess: (...args) => { calls.push(args); return { status: 0, signal: null } } }), 0)
  assert.equal(calls.length, 1)
  const [command, argv, options] = calls[0]
  assert.equal(command, 'npx')
  assert.deepEqual(argv, ['--yes', 'wrangler@4.159.0', 'deploy', '--config', fileURLToPath(new URL('../deploy/cloudflare/wrangler.toml', import.meta.url)), '--env-file', devNull, ...flags.flatMap(flag => ['--compatibility-flags', flag])])
  assert.equal(options.cwd, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
  assert.equal(options.env, environment)
  assert.equal(options.shell, false)
  assert.equal(options.stdio, 'inherit')
  assert.equal(readFileSync(new URL('../deploy/cloudflare/wrangler.toml', import.meta.url), 'utf8'), before)
})

test('extra flags and target arguments are refused before any process', () => {
  for (const argv of [['dev'], ['--env', 'production'], ['--env-file', 'other'], ['--deploy', '--name', 'other'], ['--deploy', '--deploy'], ['--dry-run'], ['--config=other'], ['--compatibility-flags', 'other'], ['--deploy=true'],
    ['--emergency'], ['--emergency', '--deploy'], ['--print', '--emergency'], ['--deploy', '--emergency', '--emergency']]) {
    assert.throws(() => runCloudflareDeployment(argv, { environment: {}, spawnProcess: () => assert.fail('Must not deploy') }), { message: 'DEPLOY_ARGUMENTS_REFUSED' })
  }
})

test('config flags are refused rather than silently replaced by the CLI array', () => {
  for (const compatibility_flags of [flags, ['nodejs_compat'], ['cots_on_external_fetch'], 'invalid', null]) {
    assert.throws(() => cloudflareDeploymentPlan([], { ...config, compatibility_flags }), { message: 'DEPLOY_CONFIG_FLAGS_REFUSED' })
  }
  assert.equal(cloudflareDeploymentPlan([], { ...config, compatibility_flags: [] }).deploy, false)
})

test('ambient environment, mismatched names, accounts and API destinations are refused without values', () => {
  for (const [key, code] of [['CLOUDFLARE_ENV', 'ENVIRONMENT'], ['WRANGLER_CI_OVERRIDE_NAME', 'NAME'], ['CLOUDFLARE_ACCOUNT_ID', 'ACCOUNT'], ['CF_ACCOUNT_ID', 'ACCOUNT'], ['CLOUDFLARE_API_BASE_URL', 'API'], ['CF_API_BASE_URL', 'API'], ['WRANGLER_API_ENVIRONMENT', 'API'], ['CLOUDFLARE_COMPLIANCE_REGION', 'API']]) {
    for (const value of ['synthetic-private-override', '']) assert.throws(() => cloudflareDeploymentPlan([], config, { [key]: value }), { message: `DEPLOY_${code}_OVERRIDE_REFUSED` })
  }
  assert.equal(cloudflareDeploymentPlan([], config, { WRANGLER_CI_OVERRIDE_NAME: config.name, CLOUDFLARE_ACCOUNT_ID: config.account_id, CF_ACCOUNT_ID: config.account_id }).deploy, false)
  assert.equal(cloudflareDeploymentPlan([], config, { WRANGLER_API_ENVIRONMENT: 'production', CLOUDFLARE_COMPLIANCE_REGION: 'public' }).deploy, false)
  assert.throws(() => cloudflareDeploymentPlan([], { ...config, compliance_region: 'other' }), { message: 'DEPLOY_API_OVERRIDE_REFUSED' })
  assert.throws(() => cloudflareDeploymentPlan([], { ...config, name: 'other' }), { message: 'DEPLOY_TARGET_INVALID' })
  assert.throws(() => cloudflareDeploymentPlan([], { ...config, account_id: 'invalid' }), { message: 'DEPLOY_TARGET_INVALID' })
})

test('deployment process failure is returned without retry or fallback', () => {
  let calls = 0
  for (const result of [{ error: new Error('synthetic-private-error') }, { status: null, signal: 'SIGTERM' }, {}]) {
    assert.throws(() => runCloudflareDeployment(['--deploy'], { environment: {}, ghProcess: notConfigured, spawnProcess: () => { calls++; return result } }), { message: 'DEPLOY_PROCESS_FAILED' })
  }
  assert.equal(calls, 3)
  assert.equal(runCloudflareDeployment(['--deploy'], { environment: {}, ghProcess: notConfigured, spawnProcess: () => ({ status: 7, signal: null }) }), 7)
})

test('one publisher: once the production environment lists both credential names, the Mac deploy needs --emergency', () => {
  const both = ghListing(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'OTHER'])
  const lines = [], calls = [], gh = []
  const spy = (command, args, options) => { gh.push([command, args, options]); return both(command, args) }
  assert.throws(() => runCloudflareDeployment(['--deploy'], { environment: {}, ghProcess: spy, output: value => lines.push(value), spawnProcess: (...args) => { calls.push(args); return { status: 0, signal: null } } }), { message: 'DEPLOY_CLOUD_PUBLISHER_ACTIVE' })
  assert.deepEqual(lines, [ONE_PUBLISHER_NOTICE])
  assert.match(ONE_PUBLISHER_NOTICE, /this Mac script is for emergencies only/)
  assert.equal(calls.length, 0, 'nothing is deployed without --emergency')
  // Names only: the listing asks GitHub for environment and secret names, through gh, with no shell.
  assert.deepEqual(gh.map(call => call.slice(0, 2)), [['gh', ENVIRONMENTS], ['gh', SECRETS]])
  for (const call of gh) assert.equal(call[2].shell, false)
  const emergency = []
  assert.equal(runCloudflareDeployment(['--deploy', '--emergency'], { environment: {}, ghProcess: both, output: value => emergency.push(value), spawnProcess: (...args) => { calls.push(args); return { status: 0, signal: null } } }), 0)
  assert.deepEqual(emergency, [ONE_PUBLISHER_NOTICE])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].includes('--emergency'), false, 'the flag never reaches Wrangler')
})

test('one publisher: no production environment yet, or an incomplete listing, deploys as before; printing never asks gh', () => {
  assert.deepEqual(cloudPublisherState(ghListing(['CLOUDFLARE_API_TOKEN'])), { state: 'not-configured' })
  assert.deepEqual(cloudPublisherState(ghListing([])), { state: 'not-configured' })
  assert.deepEqual(cloudPublisherState(ghListing(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], ['staging'])), { state: 'not-configured' })
  assert.deepEqual(cloudPublisherState(ghListing(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])), { state: 'configured' })
  for (const ghProcess of [ghListing(['CLOUDFLARE_ACCOUNT_ID']), ghListing([], [])]) {
    let calls = 0
    assert.equal(runCloudflareDeployment(['--deploy'], { environment: {}, ghProcess, output: () => assert.fail('Unexpected output'), spawnProcess: () => { calls++; return { status: 0, signal: null } } }), 0)
    assert.equal(calls, 1)
  }
  assert.equal(runCloudflareDeployment(['--print'], { environment: {}, ghProcess: () => assert.fail('print never asks gh'), output: () => {}, spawnProcess: () => assert.fail('Must not deploy') }), 0)
})

test('one publisher: gh missing (ENOENT) or the lookup fails (expired auth, no access, network, timeout) refuses without --emergency (review S5, loop3 S3)', () => {
  const failures = [
    ['gh failed: ENOENT', noGh],
    ['gh exited 1', () => ({ status: 1, signal: null, stdout: '' })],
    ['gh exited 4', (command, args) => JSON.stringify(args) === JSON.stringify(ENVIRONMENTS) ? { status: 0, signal: null, stdout: 'production\n' } : { status: 4, signal: null, stdout: '' }],
    ['gh failed: ETIMEDOUT', () => ({ error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM' })],
    ['gh failed: EACCES', () => ({ error: Object.assign(new Error('spawn gh EACCES'), { code: 'EACCES' }) })],
  ]
  for (const [reason, ghProcess] of failures) {
    assert.deepEqual(cloudPublisherState(ghProcess), { state: 'unknown', reason }, reason)
    const lines = []
    let calls = 0
    assert.throws(() => runCloudflareDeployment(['--deploy'], { environment: {}, ghProcess, output: value => lines.push(value), spawnProcess: () => { calls++; return { status: 0, signal: null } } }), { message: 'DEPLOY_CLOUD_PUBLISHER_UNKNOWN' }, reason)
    assert.equal(calls, 0, `${reason}: nothing is deployed`)
    assert.deepEqual(lines, [`${ONE_PUBLISHER_UNKNOWN_NOTICE} Reason: ${reason}.`])
    assert.match(ONE_PUBLISHER_UNKNOWN_NOTICE, /this Mac script is for emergencies only \(--deploy --emergency\)/)
    const emergency = []
    assert.equal(runCloudflareDeployment(['--deploy', '--emergency'], { environment: {}, ghProcess, output: value => emergency.push(value), spawnProcess: () => { calls++; return { status: 0, signal: null } } }), 0)
    assert.deepEqual([calls, emergency], [1, [`${ONE_PUBLISHER_UNKNOWN_NOTICE} Reason: ${reason}.`]])
  }
})
