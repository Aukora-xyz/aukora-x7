// Authority preflight for the x6.1 edge deploy.
//
// A working CI deploy turns every commit on main into a live edge change. Any
// commit Auma can make as T1 (owner session, no passkey) must therefore be
// unable to change what the deployed Worker decides, and the Worker must not
// accept a caller-claimed owner flag. This preflight fails (exit 1, one line per
// violation) while any of these holes exist on the checked-out tree:
//   a) a file in the Worker's static import closure is not T2-protected;
//   b) an owner-governance organ is not T2-only for head transitions;
//   c) the repo broker accepts a caller-supplied ownerSession flag.
// It imports the real modules and probes the real broker, but only after a
// static walk shows that everything it would execute is T2 (else it refuses).
// It never touches the network (the probe's fetch stub refuses every call) and
// reads no secrets.
// It lives under deploy/ (T2) because CI runs it in the pipeline that deploys.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WORKER_ENTRY = 'deploy/cloudflare/src/worker.mjs';
const PROBE_ORIGIN = 'https://node.example.invalid';

const STATIC_FROM = /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t]*(['"])([^'"\n]+)\1/gm;
const SIDE_EFFECT = /^[ \t]*import[ \t]*(['"])([^'"\n]+)\1/gm;
const DYNAMIC = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g;

/** Module specifiers of one source text: static import/export-from, side-effect and literal dynamic imports. */
export function moduleSpecifiers(text) {
  const found = [];
  for (const pattern of [STATIC_FROM, SIDE_EFFECT, DYNAMIC]) for (const match of text.matchAll(pattern)) found.push(match[2]);
  return found;
}

/**
 * Walk relative imports from the Worker entry. Over-inclusion fails closed:
 * an import-like comment can only add files to the T2 requirement.
 * @returns {{ files: string[], bare: {specifier: string, from: string}[], missing: {specifier: string, from: string}[] }}
 */
export function importClosure(root, entry = WORKER_ENTRY) {
  const seen = new Set();
  const bare = [];
  const missing = [];
  const queue = [resolve(root, entry)];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const from = relative(root, file).split(sep).join('/');
    for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) { bare.push({ specifier, from }); continue; }
      const target = resolve(dirname(file), specifier);
      if (!existsSync(target) || !statSync(target).isFile()) { missing.push({ specifier, from }); continue; }
      queue.push(target);
    }
  }
  return { files: [...seen].map(file => relative(root, file).split(sep).join('/')).sort(), bare, missing };
}

/** Package names of this repository's pnpm workspace members (their sources are repo files, not lockfile-pinned). */
export function workspacePackageNames(root) {
  const names = new Set();
  const manifest = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(manifest)) return names;
  const block = /^packages:\s*\n((?:[ \t]*(?:-.*|#.*)?\n)*)/m.exec(readFileSync(manifest, 'utf8'))?.[1] ?? '';
  const patterns = [...block.matchAll(/^[ \t]*-[ \t]*['"]?([^'"#\s]+)['"]?/gm)].map(match => match[1]);
  const expand = (base, segments) => {
    if (!segments.length) return [base];
    const [head, ...rest] = segments;
    if (head !== '*') return expand(join(base, head), rest);
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => expand(join(base, entry.name), rest));
  };
  for (const pattern of patterns) {
    for (const directory of expand(root, pattern.split('/'))) {
      const file = join(directory, 'package.json');
      if (!existsSync(file)) continue;
      try { const name = JSON.parse(readFileSync(file, 'utf8')).name; if (typeof name === 'string') names.add(name); } catch {}
    }
  }
  return names;
}

const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

/** (a) Every file the deployed Worker can execute must be T2; workspace packages are repo source too. */
export function closureViolations(closure, isT2ProtectedRepoPath, workspaceNames = new Set()) {
  const violations = [];
  for (const path of closure.files) {
    if (!isT2ProtectedRepoPath(path)) violations.push(`AUTHORITY_VIOLATION a: worker import closure includes non-T2 file ${path}`);
  }
  for (const { specifier, from } of closure.missing) {
    violations.push(`AUTHORITY_VIOLATION a: unresolved relative import ${specifier} in ${from}`);
  }
  for (const { specifier, from } of closure.bare) {
    if (/^(?:node|cloudflare):/.test(specifier)) continue;
    if (workspaceNames.has(packageName(specifier))) {
      violations.push(`AUTHORITY_VIOLATION a: worker imports workspace package ${packageName(specifier)} (repo source, not T2) from ${from}`);
    }
  }
  return violations;
}

/** (b) A governance organ that a T1 head transition could replace defeats the governance boundary. */
export function governanceViolations(ownerGovernanceOrgans, t2OnlyOrgans) {
  const t2 = new Set(t2OnlyOrgans);
  return ownerGovernanceOrgans.filter(organ => !t2.has(organ))
    .map(organ => `AUTHORITY_VIOLATION b: OWNER_GOVERNANCE_ORGANS member ${organ} is not in T2_ONLY_ORGANS`);
}

function brokerRequest(body) {
  return new Request(`${PROBE_ORIGIN}/_host/repo`, {
    method: 'POST',
    headers: { origin: PROBE_ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * (c) Behavioral probe of the real broker. The caller-claimed flag must not
 * stand in for an authenticated owner. A control call with a genuine owner
 * access shows the probe reaches the owner gate, so a refusal is attributable to
 * the flag being ignored, not to an unrelated precondition.
 */
export async function ownerFlagViolations(handleCloudBroker) {
  const violations = [];
  const networkCalls = [];
  const networkFetch = async input => {
    networkCalls.push(typeof input === 'string' ? input : input?.url ?? String(input));
    throw Object.assign(new Error('PREFLIGHT_NETWORK_REFUSED'), { code: 'PREFLIGHT_NETWORK_REFUSED' });
  };
  const bootstrap = { ready: true, head: { seedId: 'authority-preflight' } };
  const commit = { action: 'commit', dryRun: true, message: 'preflight', changes: [{ path: 'docs/preflight.md', content: 'x' }] };
  const call = async (body, access, env = {}) => {
    const response = await handleCloudBroker(brokerRequest(body), env, { access, bootstrap, networkFetch });
    return response.json();
  };

  const control = await call(commit, { authenticated: true, owner: true });
  const claimed = await call({ ...commit, ownerSession: true }, null);
  if (claimed?.ok === true) {
    violations.push('AUTHORITY_VIOLATION c: repo broker accepted caller-supplied ownerSession:true with access=null (commit dryRun returned ok:true)');
  } else if (control?.ok !== true) {
    violations.push(`AUTHORITY_VIOLATION c: probe inconclusive, owner-authenticated commit dryRun control was refused (${typeof control?.code === 'string' ? control.code : 'no code'}); update the probe to the broker's current owner contract`);
  }
  // A real dispatch needs a GitHub token; an inert placeholder lets the request
  // reach the network stub, which records the attempt and refuses it.
  const before = networkCalls.length;
  await call({ action: 'dispatch_workflow', ownerSession: true }, null, { GITHUB_TOKEN: 'preflight-placeholder' });
  if (networkCalls.slice(before).some(url => url.includes('/actions/workflows/'))) {
    violations.push('AUTHORITY_VIOLATION c: caller-supplied ownerSession:true with access=null reached a deploy workflow dispatch');
  }
  if (networkCalls.slice(0, before).length) {
    violations.push('AUTHORITY_VIOLATION c: commit dryRun probe attempted a network call');
  }
  return violations;
}

/** The repository modules this preflight imports, and so executes. */
export const PREFLIGHT_MODULES = Object.freeze([
  'deploy/cloudflare/src/cloud-brokers.mjs',
  'deploy/cloudflare/src/owner-grant-policy.mjs',
  'server/ball-transition.mjs',
]);

// Decided from the path alone, before anything is imported: the deploy/ prefix
// rule and the one T2 exact path the preflight loads outside it (both in
// isT2ProtectedRepoPath, deploy/cloudflare/src/cloud-brokers.mjs). Deliberately
// narrower than that predicate, so it can only refuse more.
const preImportT2 = path => path.startsWith('deploy/') || path === 'server/ball-transition.mjs';

/**
 * Code a T1 commit can change must never run inside the gate: it could rewrite
 * the verdict in memory. Walk the static closure of every module the preflight
 * would import and refuse before importing when any file in it is not T2, any
 * relative import is unresolved, or any import names a workspace package.
 */
export function preImportViolations(root, workspaceNames = workspacePackageNames(root)) {
  const violations = [];
  for (const entry of PREFLIGHT_MODULES) {
    const closure = importClosure(root, entry);
    for (const path of closure.files) {
      if (!preImportT2(path)) violations.push(`AUTHORITY_VIOLATION a: preflight module ${entry} would execute non-T2 file ${path}`);
    }
    for (const { specifier, from } of closure.missing) {
      violations.push(`AUTHORITY_VIOLATION a: preflight module ${entry} has unresolved relative import ${specifier} in ${from}`);
    }
    for (const { specifier, from } of closure.bare) {
      if (workspaceNames.has(packageName(specifier))) {
        violations.push(`AUTHORITY_VIOLATION a: preflight module ${entry} would execute workspace package ${packageName(specifier)} (repo source, not T2) from ${from}`);
      }
    }
  }
  return [...new Set(violations)];
}

/** Run all checks against the real modules of the tree at root. */
export async function runPreflight(root = DEFAULT_ROOT) {
  const load = path => import(pathToFileURL(join(root, path)).href);
  const names = workspacePackageNames(root);
  const refused = preImportViolations(root, names);
  if (refused.length) {
    return [...refused, 'AUTHORITY_VIOLATION a: preflight refused to import repository modules; checks a, b and c did not run'];
  }
  const violations = [];
  const guarded = async (label, check) => {
    try { violations.push(...await check()); }
    catch (error) { violations.push(`AUTHORITY_VIOLATION ${label}: check could not run (${error?.code ?? error?.message ?? 'error'})`); }
  };
  await guarded('a', async () => {
    const { isT2ProtectedRepoPath } = await load('deploy/cloudflare/src/cloud-brokers.mjs');
    // The pre-import walk used a path-only rule; confirm the real predicate agrees.
    const loaded = [...new Set(PREFLIGHT_MODULES.flatMap(entry => importClosure(root, entry).files))].sort();
    const mismatch = loaded.filter(path => !isT2ProtectedRepoPath(path))
      .map(path => `AUTHORITY_VIOLATION a: preflight executed ${path}, which isT2ProtectedRepoPath does not protect`);
    return [...mismatch, ...closureViolations(importClosure(root), isT2ProtectedRepoPath, names)];
  });
  await guarded('b', async () => {
    const { OWNER_GOVERNANCE_ORGANS } = await load('deploy/cloudflare/src/owner-grant-policy.mjs');
    const { T2_ONLY_ORGANS } = await load('server/ball-transition.mjs');
    if (!Array.isArray(OWNER_GOVERNANCE_ORGANS) || !Array.isArray(T2_ONLY_ORGANS)) throw new Error('ORGAN_LISTS_MISSING');
    return governanceViolations(OWNER_GOVERNANCE_ORGANS, T2_ONLY_ORGANS);
  });
  await guarded('c', async () => {
    const { handleCloudBroker } = await load('deploy/cloudflare/src/cloud-brokers.mjs');
    return ownerFlagViolations(handleCloudBroker);
  });
  return violations;
}

export async function main(args = process.argv.slice(2)) {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
    else throw new Error('AUTHORITY_ARGUMENT');
  }
  const violations = await runPreflight(root);
  for (const line of violations) console.error(line);
  if (violations.length) console.error(`FAIL authority preflight: ${violations.length} violations`);
  else console.log('AUTHORITY preflight ok');
  return violations.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`FAIL authority preflight: ${error.message}`); process.exitCode = 1; });
}
