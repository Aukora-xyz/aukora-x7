import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isT2ProtectedRepoPath } from '../cloudflare/src/cloud-brokers.mjs';
import {
  closureViolations, governanceViolations, importClosure, moduleSpecifiers, ownerFlagViolations, preImportViolations, runPreflight, workspacePackageNames,
} from './authority-preflight.mjs';

const script = fileURLToPath(new URL('./authority-preflight.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// Fixture trees live under the CI runner's temp directory, or under an explicit
// scratch directory locally (PREFLIGHT_TEST_TMPDIR), else the OS default.
const fixtureBase = process.env.PREFLIGHT_TEST_TMPDIR || process.env.RUNNER_TEMP || tmpdir();

function fixture(t, files) {
  mkdirSync(fixtureBase, { recursive: true });
  const root = mkdtempSync(join(fixtureBase, 'x61-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('module specifiers cover static, re-export, side-effect, multi-line and literal dynamic imports', () => {
  const text = [
    "import { a } from './a.mjs'",
    "export { b } from '../b.mjs'",
    "export * from \"./c.mjs\"",
    "import './d.mjs'",
    'import {\n  e,\n  f,\n} from "./e.mjs"',
    "const g = await import('./g.mjs')",
    "import { x } from 'node:crypto'",
  ].join('\n');
  assert.deepEqual(moduleSpecifiers(text).sort(), ['../b.mjs', './a.mjs', './c.mjs', './d.mjs', './e.mjs', './g.mjs', 'node:crypto'].sort());
});

test('a: a non-T2 file reached from the Worker entry is a violation; an all-T2 closure passes', t => {
  const bad = fixture(t, {
    'deploy/cloudflare/src/worker.mjs': "import { h } from './helper.mjs'\nexport default { fetch: h }\n",
    'deploy/cloudflare/src/helper.mjs': "export { rules as h } from '../../../server/rules.mjs'\n",
    'server/rules.mjs': "export const rules = () => 1\n",
  });
  const badClosure = importClosure(bad);
  assert.deepEqual(badClosure.files, ['deploy/cloudflare/src/helper.mjs', 'deploy/cloudflare/src/worker.mjs', 'server/rules.mjs']);
  assert.deepEqual(closureViolations(badClosure, isT2ProtectedRepoPath), ['AUTHORITY_VIOLATION a: worker import closure includes non-T2 file server/rules.mjs']);

  const good = fixture(t, {
    'deploy/cloudflare/src/worker.mjs': "import '../../../server/ball-transition.mjs'\nimport { x } from 'node:crypto'\n",
    'server/ball-transition.mjs': "export const T2_ONLY_ORGANS = []\n",
  });
  assert.deepEqual(closureViolations(importClosure(good), isT2ProtectedRepoPath), []);
});

test('a: unresolved relative imports and workspace-package imports fail closed', t => {
  const root = fixture(t, {
    'pnpm-workspace.yaml': "packages:\n  - packages/*/*\n  # comment\n  - 'apps/*'\n\noverrides: {}\n",
    'packages/util/local/package.json': JSON.stringify({ name: '@fixture/local' }),
    'apps/web/package.json': JSON.stringify({ name: '@fixture/web' }),
    'deploy/cloudflare/src/worker.mjs': "import './gone.mjs'\nimport { y } from '@fixture/local/sub.js'\nimport { z } from '@noble/curves/utils.js'\n",
  });
  assert.deepEqual([...workspacePackageNames(root)].sort(), ['@fixture/local', '@fixture/web']);
  assert.deepEqual(closureViolations(importClosure(root), isT2ProtectedRepoPath, workspacePackageNames(root)), [
    'AUTHORITY_VIOLATION a: unresolved relative import ./gone.mjs in deploy/cloudflare/src/worker.mjs',
    'AUTHORITY_VIOLATION a: worker imports workspace package @fixture/local (repo source, not T2) from deploy/cloudflare/src/worker.mjs',
  ]);
});

test('b: a governance organ missing from the T2-only list is a violation; a covered list passes', () => {
  assert.deepEqual(governanceViolations(['seed-pearl', 'seed-aura'], ['seed-pearl']), [
    'AUTHORITY_VIOLATION b: OWNER_GOVERNANCE_ORGANS member seed-aura is not in T2_ONLY_ORGANS',
  ]);
  assert.deepEqual(governanceViolations(['seed-pearl', 'seed-aura'], ['seed-aura', 'seed-pearl', 'gate-judge']), []);
});

// Synthetic brokers with the real broker's call shape: (request, env, options) => Response.
function syntheticBroker({ honourFlag }) {
  return async (request, env, { access, networkFetch }) => {
    const input = await request.json();
    const owner = Boolean(access?.authenticated && access?.owner) || (honourFlag && input.ownerSession === true);
    if (!owner) return Response.json({ ok: false, code: 'OWNER_REQUIRED' }, { status: 403 });
    if (input.action === 'dispatch_workflow') {
      try { await networkFetch('https://api.github.com/repos/fixture/actions/workflows/deploy-x61.yml/dispatches'); }
      catch { return Response.json({ ok: false, code: 'BROKER_UPSTREAM_FAILED' }, { status: 502 }); }
    }
    return Response.json({ ok: true, dryRun: true });
  };
}

test('c: a broker that honours a caller-supplied owner flag is a violation; one that ignores it passes', async () => {
  assert.deepEqual(await ownerFlagViolations(syntheticBroker({ honourFlag: true })), [
    'AUTHORITY_VIOLATION c: repo broker accepted caller-supplied ownerSession:true with access=null (commit dryRun returned ok:true)',
    'AUTHORITY_VIOLATION c: caller-supplied ownerSession:true with access=null reached a deploy workflow dispatch',
  ]);
  assert.deepEqual(await ownerFlagViolations(syntheticBroker({ honourFlag: false })), []);
});

test('c: a probe that cannot reach the owner gate is reported inconclusive, never passed', async () => {
  const refuseAll = async () => Response.json({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, { status: 503 });
  assert.deepEqual(await ownerFlagViolations(refuseAll), [
    "AUTHORITY_VIOLATION c: probe inconclusive, owner-authenticated commit dryRun control was refused (BOOTSTRAP_REQUIRED); update the probe to the broker's current owner contract",
  ]);
});

test('integration: the real tree yields only well-formed violation lines and the command exit matches', async () => {
  const violations = await runPreflight(repoRoot);
  for (const line of violations) assert.match(line, /^AUTHORITY_VIOLATION [abc]: /);
  assert.ok(!violations.some(line => line.includes('could not run')), violations.join('\n'));
  assert.ok(!violations.some(line => line.includes('probe inconclusive')), violations.join('\n'));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, violations.length ? 1 : 0);
  for (const line of violations) assert.ok(result.stderr.includes(line));
});

test('a: the preflight refuses, without executing it, a non-T2 file its own imports would run', async t => {
  const root = fixture(t, {
    // If imported, the T1 file would write a marker and could rewrite the verdict in memory.
    'deploy/cloudflare/src/cloud-brokers.mjs': "import '../../../server/t1-rules.mjs'\nexport const isT2ProtectedRepoPath = () => true\n",
    'deploy/cloudflare/src/owner-grant-policy.mjs': 'export const OWNER_GOVERNANCE_ORGANS = []\n',
    'deploy/cloudflare/src/worker.mjs': 'export default {}\n',
    'server/ball-transition.mjs': 'export const T2_ONLY_ORGANS = []\n',
    'server/t1-rules.mjs': "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./EXECUTED', import.meta.url), 'x')\n",
  });
  assert.deepEqual(await runPreflight(root), [
    'AUTHORITY_VIOLATION a: preflight module deploy/cloudflare/src/cloud-brokers.mjs would execute non-T2 file server/t1-rules.mjs',
    'AUTHORITY_VIOLATION a: preflight refused to import repository modules; checks a, b and c did not run',
  ]);
  assert.ok(!existsSync(join(root, 'server/EXECUTED')), 'the T1 module must not have been executed');
});

test('a: the real preflight modules import only T2 files', () => {
  assert.deepEqual(preImportViolations(repoRoot), []);
});

// Jobs of a workflow, by the two-space job keys under jobs:.
function workflowJobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const jobs = {};
  const keys = [...body.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  keys.forEach((match, i) => { jobs[match[1]] = body.slice(match.index, keys[i + 1]?.index ?? body.length); });
  return jobs;
}

test('deploy workflow: T1 build code never shares a job with the bundle, the scans or a secret, and only the newest main deploys', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy-x61.yml'), 'utf8');
  // GitHub rejects secrets in if: at parse time; that broke every earlier run.
  assert.deepEqual(workflow.split('\n').filter(line => /^\s*(?:-\s*)?if:/.test(line) && /\bsecrets\b/.test(line)), []);
  // One workflow-level queue for main that never cancels a run in progress and keeps every pending run; no job-level
  // groups (deploy-workflow.test.mjs asserts the queueing).
  const header = workflow.slice(0, workflow.indexOf('\njobs:\n'));
  assert.match(header, /^concurrency:\n(?: {2}#[^\n]*\n)? {2}group: [^\n]*'deploy-x61-publish-main'[^\n]*\n {2}cancel-in-progress: false\n {2}queue: max$/m);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);
  // A dependency cache written by the build job could be restored by a trusted job.
  assert.ok(!/^\s*cache:/m.test(workflow), 'no job restores or saves a dependency cache');
  const jobs = workflowJobs(workflow);
  // Observation is its own workflow (observe-x61.yml), outside this queue (review loop3 MUST).
  assert.deepEqual(Object.keys(jobs).sort(), ['build', 'bundle', 'deploy', 'preflight', 'scrub-dist', 'target']);
  for (const [name, job] of Object.entries(jobs)) {
    if (name !== 'deploy') assert.ok(!job.includes('secrets'), `${name} holds no secret`);
    if (name !== 'target') assert.match(job, /needs: (?:target|\[target, )/, `${name} works on the target commit`);
    if (name !== 'build') assert.ok(!job.includes('build-preview'), `${name} runs no build code`);
    if (/pnpm install/.test(job)) assert.match(job, /pnpm install --frozen-lockfile --ignore-scripts/, `${name} installs without scripts`);
  }
  for (const step of ['node --test deploy/ci/*.test.mjs', 'node deploy/ci/scrub-gate.mjs --source', 'node deploy/ci/authority-preflight.mjs']) {
    assert.ok(jobs.preflight.includes(step), step);
  }
  // The untrusted build job hands over only the web assets.
  assert.ok(jobs.build.includes('node server/build-preview.mjs'));
  assert.ok(!/wrangler|scrub-gate|x61-worker-bundle|outputs:/.test(jobs.build), 'build job produces nothing trusted');
  // right after the build, before its upload, the built page must name the target commit (text read only).
  const builtOrder = ['node server/build-preview.mjs', 'node deploy/ci/built-notice-check.mjs apps/web/dist --commit "$TARGET_SHA"', 'name: x61-web-dist'];
  builtOrder.reduce((last, step) => { const at = jobs.build.indexOf(step); assert.ok(at > last, step); return at; }, -1);
  assert.match(jobs.build, /^ {10}TARGET_SHA: \$\{\{ needs\.target\.outputs\.sha \}\}\n {8}run: node deploy\/ci\/built-notice-check\.mjs /m);
  assert.match(jobs['scrub-dist'], /needs: \[target, build\]/);
  assert.ok(!/pnpm|npx/.test(jobs['scrub-dist']), 'the dist scan runs no installed code');
  assert.ok(jobs['scrub-dist'].indexOf('scrub-gate.mjs --dist') < jobs['scrub-dist'].indexOf('id: digest'));
  assert.match(jobs.bundle, /needs: target\n/, 'the bundle job never consumes build output: it needs only the target commit');
  const bundleOrder = ['wrangler@4.155.0 deploy --dry-run', 'scrub-gate.mjs --bundle worker-bundle', 'id: digest', 'name: x61-worker-bundle'];
  bundleOrder.reduce((last, step) => { const at = jobs.bundle.indexOf(step); assert.ok(at > last, step); return at; }, -1);
  // wrangler resolves a relative --outdir against the config directory, which would leave the scan an empty folder.
  assert.ok(jobs.bundle.includes('--outdir "$GITHUB_WORKSPACE/worker-bundle"'), 'the bundle is written to an absolute path');
  assert.ok(jobs.bundle.includes('-s "$GITHUB_WORKSPACE/worker-bundle/worker.js"'), 'a missing worker.js fails the bundle job');
  assert.ok(jobs.deploy.includes('--no-bundle "$GITHUB_WORKSPACE/worker-bundle/worker.js"'), 'deploy uploads the scanned file by absolute path');
  const deploy = jobs.deploy;
  assert.match(deploy, /needs: \[target, preflight, scrub-dist, bundle\]/);
  for (const [name, job] of Object.entries(jobs)) assert.ok(!/concurrency:/.test(job), `${name} has no job-level concurrency group`);
  assert.match(deploy, /^ {4}environment: production$/m);
  assert.match(deploy, /needs\.scrub-dist\.outputs\.dist_digest/);
  assert.match(deploy, /needs\.bundle\.outputs\.worker_digest/);
  for (const gate of ['preflight', 'build', 'scrub-dist', 'bundle']) {
    assert.match(jobs[gate], /ref: \$\{\{ needs\.target\.outputs\.sha \}\}/, gate);
  }
  const deployOrder = ['Verify both artifacts', 'Require Cloudflare credentials', 'Read the live Worker deployment before deploying',
    'Record the live Worker version and the rollback command', "Publish only main's newest commit", 'wrangler@4.155.0 deploy --config',
    'Confirm the new build is live'];
  deployOrder.reduce((last, step) => { const at = deploy.indexOf(step); assert.ok(at > last, step); return at; }, -1);
  assert.ok(!/wrangler@[0-9.]+ rollback/.test(workflow), 'nothing in the deploy workflow rolls back');
  // The Cloudflare credential reaches the presence check (as true or false only), the status read and the deploy, all
  // Wrangler-only. The newest-commit check, the live check and every deploy/ci script hold none
  // (workflow-credentials.test.mjs checks what those steps run).
  const deploySteps = deploy.split('\n      - name: ').slice(1);
  const withSecrets = deploySteps.filter(step => /secrets\./.test(step)).map(step => step.split('\n')[0]);
  assert.deepEqual(withSecrets, ['Require Cloudflare credentials', 'Read the live Worker deployment before deploying',
    'Deploy the scrubbed Worker bundle to Cloudflare']);
  for (const step of deploySteps.filter(text => /secrets\./.test(text))) {
    assert.deepEqual([...new Set(step.match(/secrets\.[A-Z0-9_]+/g))].sort(), ['secrets.CLOUDFLARE_ACCOUNT_ID', 'secrets.CLOUDFLARE_API_TOKEN']);
  }
  assert.ok(!/wrangler@(?!4\.155\.0\b)/.test(workflow), 'every wrangler invocation is pinned to 4.155.0');
  // The observer (observe-x61.yml) holds no secret at all (signed-out only; the owner credential is never a CI secret):
  // it runs only T2 files (deploy/ci) and a Playwright copy fetched by integrity hash outside the checkout, never the T1
  // workspace dependency tree.
  const observeWorkflow = readFileSync(join(repoRoot, '.github/workflows/observe-x61.yml'), 'utf8');
  const observeJobs = workflowJobs(observeWorkflow);
  assert.deepEqual(Object.keys(observeJobs), ['target', 'observe']);
  assert.ok(!/secrets\./.test(observeJobs.target), 'resolving what to observe holds no secret');
  assert.ok(!/CLOUDFLARE_|environment:|wrangler/.test(observeWorkflow), 'the observer holds no Cloudflare credential and declares no environment');
  assert.ok(!/^\s*cache:/m.test(observeWorkflow));
  const observe = observeJobs.observe;
  assert.match(observe, /needs: target\n/);
  assert.match(observe, /sparse-checkout: \|\s*\n\s*deploy\/ci\s*\n/);
  assert.match(observe, /persist-credentials: false/);
  assert.ok(!/pnpm (?:install|i|add|exec)\b|npm (?:install|i|ci)\b|npx /.test(observe), 'observe installs nothing from the workspace');
  assert.equal((observe.match(/'sha512-[A-Za-z0-9+\/]{86}=='/g) || []).length, 2, 'both Playwright tarballs are integrity-pinned');
  assert.ok(!/secrets\./.test(observeWorkflow), 'the observer names no secret');
  assert.ok(!/X61_OWNER_JWT/.test(observeWorkflow), 'the observer never names the owner credential');
});
