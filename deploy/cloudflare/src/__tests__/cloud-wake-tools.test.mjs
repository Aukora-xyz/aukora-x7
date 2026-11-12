/** Her read-only tools and model door for the cloud wake. Stub GitHub and stub providers only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudWakeRepoRead, CLOUD_WAKE_REPO_ACTIONS } from '../cloud-brokers.mjs'
import {
  runCloudWakeRepoTool, cloudWakeProvider, cloudWakeProviderOrder, cloudWakeModelTurn, CLOUD_WAKE_REPO_TOOLS, CLOUD_WAKE_REPO_TOOL_NAMES,
  CLOUD_WAKE_TOOL_RESULT_BYTES, CLOUD_WAKE_LEGACY_PROVIDERS, wakeCredentialSafe,
} from '../cloud-wake-tools.mjs'
import { cloudWakeTextSafe } from '../head-do.mjs'

const SEED = 'a'.repeat(64)
const GH = 'ghp_FIXTUREnotarealtoken0123456789abcd'
const sha = n => String(n).repeat(40).slice(0, 40)
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

test('the wake reads only read, search and log on main, with exactly their fields', async () => {
  assert.deepEqual(Object.keys(CLOUD_WAKE_REPO_ACTIONS), ['read', 'search', 'log'])
  const env = { GITHUB_TOKEN: GH }
  const fetchImpl = async () => { throw new Error('no network expected') }
  for (const input of [{ action: 'write', path: 'docs/a.md', content: 'x' }, { action: 'commit' }, { action: 'stage_proposal' }, { action: 'branch_create' }, null]) {
    assert.deepEqual(await cloudWakeRepoRead(input, env, { seedId: SEED, networkFetch: fetchImpl }), { ok: false, code: 'CLOUD_WAKE_REPO_ACTION_REFUSED' })
  }
  assert.deepEqual(await cloudWakeRepoRead({ action: 'read', path: 'README.md', branch: 'auma/sandbox/x' }, env, { seedId: SEED, networkFetch: fetchImpl }),
    { ok: false, code: 'BROKER_QUERY_INVALID' })
  assert.deepEqual(await cloudWakeRepoRead({ action: 'log' }, env, { seedId: 'nope', networkFetch: fetchImpl }), { ok: false, code: 'CLOUD_WAKE_REPO_UNSEEDED' })
})

test('the wake log goes through the broker read path, and a missing GitHub token is a code, not a crash', async () => {
  assert.deepEqual(await cloudWakeRepoRead({ action: 'log', limit: 2 }, {}, { seedId: SEED, networkFetch: async () => json([]) }),
    { ok: false, code: 'GITHUB_BROKER_TOKEN_UNCONFIGURED' })
  const urls = []
  const networkFetch = async (url, init) => {
    urls.push({ url, auth: init.headers.authorization, method: init.method })
    return json([{ sha: sha(1), commit: { message: 'first line\nbody' }, parents: [{ sha: sha(2) }] }, { sha: sha(3), commit: { message: 'second' }, parents: [] }])
  }
  const out = await cloudWakeRepoRead({ action: 'log', limit: 2 }, { GITHUB_TOKEN: GH }, { seedId: SEED, networkFetch })
  assert.equal(out.ok, true)
  assert.deepEqual(out.commits.map(commit => commit.sha), [sha(1), sha(3)])
  assert.deepEqual(urls, [{ url: 'https://api.github.com/repos/your_org_x/your-node/commits?sha=main&per_page=2', auth: `Bearer ${GH}`, method: 'GET' }])
  assert.equal(JSON.stringify(out).includes(GH), false)
})

test('a repository answer that echoes a configured secret is refused by the broker scrub', async () => {
  const networkFetch = async () => json([{ sha: sha(1), commit: { message: `leak ${GH}` }, parents: [] }])
  const out = await cloudWakeRepoRead({ action: 'log', limit: 1 }, { GITHUB_TOKEN: GH }, { seedId: SEED, networkFetch })
  assert.deepEqual(out, { ok: false, code: 'BROKER_PRIVATE_CONTENT_REFUSED' })
})

test('her repo tools are read-only OpenAI-shape functions and other names fall through to the wake untouched', async () => {
  assert.deepEqual(CLOUD_WAKE_REPO_TOOL_NAMES, ['readRepoFile', 'searchRepository', 'recentCommits'])
  for (const definition of CLOUD_WAKE_REPO_TOOLS) assert.equal(definition.function.parameters.additionalProperties, false)
  assert.equal(await runCloudWakeRepoTool('appendWakeCheckpoint', {}, { env: {}, seedId: SEED }), null)
  assert.equal(await runCloudWakeRepoTool('readMirrorText', { path: 'x' }, { env: {}, seedId: SEED }), null)
})

test('readRepoFile pages long files within the wake result cap, even when escaping grows the text', async () => {
  const reads = []
  const content = '"\n'.repeat(5000)
  const read = async input => { reads.push(input); return { ok: true, path: input.path, source: 'github-main', content } }
  const out = await runCloudWakeRepoTool('readRepoFile', { path: 'docs/NORTH-STAR.md' }, { env: {}, seedId: SEED, read })
  // The whole file is read (and screened); the page is cut here.
  assert.deepEqual(reads, [{ action: 'read', path: 'docs/NORTH-STAR.md' }])
  assert.equal(out.ok, true)
  assert.equal(out.truncated, true)
  assert.ok(out.nextOffset > 0 && out.nextOffset === out.content.length)
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= CLOUD_WAKE_TOOL_RESULT_BYTES)
})

test('tool arguments are checked exactly, and broker refusals pass through as codes', async () => {
  const read = async () => ({ ok: false, code: 'REPO_PRIVATE_FALLBACK_REFUSED' })
  const ctx = { env: {}, seedId: SEED, read }
  assert.deepEqual(await runCloudWakeRepoTool('readRepoFile', { path: 'x', extra: 1 }, ctx), { ok: false, code: 'CLOUD_WAKE_TOOL_ARGUMENTS_INVALID' })
  assert.deepEqual(await runCloudWakeRepoTool('searchRepository', { query: 'a' }, ctx), { ok: false, code: 'CLOUD_WAKE_TOOL_ARGUMENTS_INVALID' })
  assert.deepEqual(await runCloudWakeRepoTool('recentCommits', { limit: 99 }, ctx), { ok: false, code: 'CLOUD_WAKE_TOOL_ARGUMENTS_INVALID' })
  assert.deepEqual(await runCloudWakeRepoTool('readRepoFile', { path: '.env' }, ctx), { ok: false, code: 'REPO_PRIVATE_FALLBACK_REFUSED' })
  assert.deepEqual(await runCloudWakeRepoTool('readRepoFile', 'not-an-object', ctx), { ok: false, code: 'CLOUD_WAKE_TOOL_ARGUMENTS_INVALID' })
})

test('searchRepository and recentCommits come back bounded; credential-shaped output is refused by the wake text check', async () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ path: `docs/f${index}.md`, line: index + 1, text: 'x'.repeat(400) }))
  const searchRead = async (input, _env, context) => {
    assert.equal(typeof context.screenFile, 'function')
    return { ok: true, matches: many, truncated: false, screenedOut: 0 }
  }
  const search = await runCloudWakeRepoTool('searchRepository', { query: 'auma' }, { env: {}, seedId: SEED, read: searchRead })
  assert.equal(search.ok, true)
  assert.ok(search.matches.length <= 20 && search.truncated === true)
  assert.ok(Buffer.byteLength(JSON.stringify(search)) <= CLOUD_WAKE_TOOL_RESULT_BYTES)
  const env = { OPENAI_API_KEY: 'sk-FIXTUREopenai0123456789' }
  const unsafe = await runCloudWakeRepoTool('recentCommits', {}, { env, seedId: SEED, textSafe: text => cloudWakeTextSafe(text, env),
    read: async () => ({ ok: true, commits: [{ sha: sha(1), message: 'api_key: hunter2' }] }) })
  assert.deepEqual(unsafe, { ok: false, code: 'CLOUD_WAKE_TOOL_OUTPUT_REFUSED' })
})

// Authorization: Basic, AWS secret keys and escaped property names passed.
test('the credential filter covers authorization headers, AWS keys, env-style secrets and escaped names', () => {
  for (const text of ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'curl -H "Authorization: Token abc"', 'Proxy-Authorization: Digest x',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'aws_secret_access_key = abc123', 'key AKIAIOSFODNN7EXAMPLE', 'DB_PASSWORD=hunter2',
    '{\\"api_key\\": \\"x\\"}', '"password": "x"', "client_secret='abc'"]) {
    assert.equal(wakeCredentialSafe(text, {}), false, text)
  }
  for (const text of ['feat: add the api key rotation docs', 'Basic usage of the repo', 'the password field is required', 'authorization flow docs']) {
    assert.equal(wakeCredentialSafe(text, {}), true, text)
  }
})

// Paging bypassed screening (offset 0 refused, offset 9 returned `letmein`).
test('a file is screened whole before any page is cut; a search line from a file with a credential is withheld', async () => {
  const read = async input => ({ ok: true, path: input.path, source: 'github-main', content: 'password=letmein\nmore\n' })
  for (const offset of [0, 9, 10, 17]) {
    assert.deepEqual(await runCloudWakeRepoTool('readRepoFile', { path: 'docs/a.md', offset }, { env: {}, seedId: SEED, read }),
      { ok: false, code: 'CLOUD_WAKE_TOOL_OUTPUT_REFUSED' }, String(offset))
  }
  // A stand-in broker: it hands each file's bytes to the wake's screen BEFORE extracting lines, as searchRepository does.
  const files = { 'docs/leaky.md': 'password=\nletmein\n', 'docs/clean.md': 'letmein is a phrase\n' }
  const searchRead = async (input, _env, context) => {
    assert.equal(input.action, 'search')
    const matches = []
    let screenedOut = 0
    for (const [path, text] of Object.entries(files)) {
      if (context.screenFile(text) !== true) { screenedOut++; continue }
      text.split('\n').forEach((line, index) => { if (line.includes(input.query)) matches.push({ path, line: index + 1, text: line }) })
    }
    return { ok: true, truncated: false, matches, screenedOut }
  }
  const out = await runCloudWakeRepoTool('searchRepository', { query: 'letmein' }, { env: {}, seedId: SEED, read: searchRead })
  assert.equal(out.ok, true)
  assert.deepEqual(out.matches.map(match => match.path), ['docs/clean.md'])
  assert.equal(out.withheld, 1)
  // A broker answer that does not say it screened is refused outright.
  assert.deepEqual(await runCloudWakeRepoTool('searchRepository', { query: 'letmein' }, { env: {}, seedId: SEED,
    read: async () => ({ ok: true, truncated: false, matches: [{ path: 'docs/x.md', line: 1, text: 'letmein' }] }) }), { ok: false, code: 'CLOUD_WAKE_SEARCH_UNSCREENED' })
})

// Search screened bytes from a SECOND read of mutable content, so a line from a file that
// held a credential was released once main moved on. Through the REAL broker search: one read per file, screened whole.
test('through the real broker search, a file is screened at the same read its lines come from, and read once', async () => {
  const REPO = '/repos/your_org_x/your-node', COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40), BLOB = 'c'.repeat(40)
  const contents = { 'server/leaky.mjs': 'password=\nletmein\n', 'server/clean.mjs': 'letmein is a phrase\n' }
  const reads = {}
  const networkFetch = async (url) => {
    const target = new URL(url)
    if (target.pathname === REPO + '/commits/main' || target.pathname === REPO + '/commits/' + COMMIT) return json({ sha: COMMIT, commit: { message: 'm', tree: { sha: TREE } } })
    if (target.pathname === REPO + '/git/trees/' + TREE) {
      return json({ sha: TREE, truncated: false, tree: [{ path: 'server', mode: '040000', type: 'tree', sha: TREE },
        ...Object.keys(contents).map(path => ({ path, mode: '100644', type: 'blob', sha: BLOB, size: 10 }))] })
    }
    if (target.pathname.startsWith(REPO + '/contents/')) {
      const path = decodeURIComponent(target.pathname.slice((REPO + '/contents/').length))
      reads[path] = (reads[path] ?? 0) + 1
      const body = contents[path]
      // After its first read the leaky file turns harmless, as main moving on would make it.
      contents[path] = 'nothing here\n'
      return json({ type: 'file', path, sha: BLOB, encoding: 'base64', content: Buffer.from(body).toString('base64') })
    }
    throw new Error('unexpected ' + url)
  }
  const env = { GITHUB_TOKEN: GH, MIRROR: { idFromName: name => name, get: () => ({ fetch: async () => json({ ok: true, lineageId: '11111111-1111-4111-8111-111111111111', revision: 1, homeFiles: [], workspaceFiles: [] }) }) } }
  const out = await runCloudWakeRepoTool('searchRepository', { query: 'letmein' }, { env, seedId: SEED, networkFetch })
  assert.equal(out.ok, true)
  assert.deepEqual(out.matches, [{ path: 'server/clean.mjs', line: 1, text: 'letmein is a phrase' }])
  assert.equal(out.withheld, 1)
  assert.deepEqual(reads, { 'server/clean.mjs': 1, 'server/leaky.mjs': 1 })
  // The broker refuses a wake search that brings no screen.
  assert.deepEqual(await cloudWakeRepoRead({ action: 'search', query: 'letmein' }, env, { seedId: SEED, networkFetch }), { ok: false, code: 'CLOUD_WAKE_SCREEN_REQUIRED' })
})

// textSafe defaulted to accept-all, and `api_key: hunter2` in a commit subject went through.
test('the credential filter is mandatory: no caller can return credential-shaped text to the model or the journal', async () => {
  const read = async () => ({ ok: true, commits: [{ sha: sha(1), message: 'chore: rotate api_key: hunter2' }] })
  assert.deepEqual(await runCloudWakeRepoTool('recentCommits', {}, { env: {}, seedId: SEED, read }), { ok: false, code: 'CLOUD_WAKE_TOOL_OUTPUT_REFUSED' })
  assert.deepEqual(await runCloudWakeRepoTool('recentCommits', {}, { env: {}, seedId: SEED, read, textSafe: () => true }),
    { ok: false, code: 'CLOUD_WAKE_TOOL_OUTPUT_REFUSED' })
  const env = { DEEPSEEK_API_KEY: 'plain-looking-value-123' }
  const leak = async () => ({ ok: true, path: 'docs/a.md', source: 'github-main', content: 'value plain-looking-value-123 here', nextOffset: null })
  assert.deepEqual(await runCloudWakeRepoTool('readRepoFile', { path: 'docs/a.md' }, { env, seedId: SEED, read: leak }), { ok: false, code: 'CLOUD_WAKE_TOOL_OUTPUT_REFUSED' })
  for (const text of ['Bearer abc.def', 'sk-ant-api03-0123456789abcdef', 'password=letmein', 'ghp_0123456789abcdefghijklmnop']) {
    assert.equal(wakeCredentialSafe(text, {}), false, text)
  }
  assert.equal(wakeCredentialSafe('feat: add the api key rotation docs', {}), true)
})

// JSON escaped the quotes before filtering, so a quoted pair slipped through.
test('the filter reads raw string fields before serialisation: quoted credential pairs are refused', async () => {
  for (const message of ['chore: rotate "api_key": "hunter2"', "chore: 'password' = 'x'", 'note {"client_secret":"abc"}']) {
    const read = async () => ({ ok: true, commits: [{ sha: sha(1), message }] })
    assert.deepEqual(await runCloudWakeRepoTool('recentCommits', {}, { env: {}, seedId: SEED, read }), { ok: false, code: 'CLOUD_WAKE_TOOL_OUTPUT_REFUSED' }, message)
  }
  // A secret in a field the projection would drop (the commit body) is still refused: raw answers are checked first.
  const body = async () => ({ ok: true, commits: [{ sha: sha(1), message: 'feat: x\n\napi_key: hunter2' }] })
  assert.deepEqual(await runCloudWakeRepoTool('recentCommits', {}, { env: {}, seedId: SEED, read: body }), { ok: false, code: 'CLOUD_WAKE_TOOL_OUTPUT_REFUSED' })
  const huge = async () => ({ ok: true, path: 'docs/a.md', source: 'github-main', content: 'x'.repeat(9000) + ' "api_key": "hunter2"', nextOffset: null })
  assert.deepEqual(await runCloudWakeRepoTool('readRepoFile', { path: 'docs/a.md' }, { env: {}, seedId: SEED, read: huge }), { ok: false, code: 'CLOUD_WAKE_TOOL_OUTPUT_REFUSED' })
})

test('the wake keeps its old provider order unless CLOUD_WAKE_PROVIDER names one, and a named provider is never swapped', () => {
  assert.deepEqual(cloudWakeProviderOrder({}), CLOUD_WAKE_LEGACY_PROVIDERS)
  // An unknown non-empty setting is refused, never read as "use the legacy order".
  assert.equal(cloudWakeProviderOrder({ CLOUD_WAKE_PROVIDER: 'mystery' }), null)
  assert.deepEqual(cloudWakeProvider({ CLOUD_WAKE_PROVIDER: 'anthropicc', DEEPSEEK_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }), { ok: false, code: 'CLOUD_WAKE_PROVIDER_UNKNOWN' })
  assert.deepEqual(cloudWakeProviderOrder({ CLOUD_WAKE_PROVIDER: '   ' }), CLOUD_WAKE_LEGACY_PROVIDERS)
  assert.deepEqual(cloudWakeProvider({ DEEPSEEK_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }), { ok: true, provider: 'deepseek' })
  assert.deepEqual(cloudWakeProvider({ CLOUD_WAKE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a', DEEPSEEK_API_KEY: 'k' }), { ok: true, provider: 'anthropic' })
  assert.deepEqual(cloudWakeProvider({ CLOUD_WAKE_PROVIDER: 'openrouter', DEEPSEEK_API_KEY: 'k' }),
    { ok: false, code: 'PROVIDER_SECRET_NOT_CONFIGURED', tried: ['openrouter'] })
  assert.deepEqual(cloudWakeProvider({}), { ok: false, code: 'PROVIDER_SECRET_NOT_CONFIGURED', tried: ['deepseek', 'openai'] })
})

test('one wake model turn goes through the door with her tools, and a tool call comes back ready to run', async () => {
  const sent = []
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) })
    return json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_9', name: 'recentCommits', input: {} }] })
  }
  const out = await cloudWakeModelTurn({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-FIXTURE' }, provider: 'anthropic', toolChoice: 'auto', maxTokens: 2048,
    messages: [{ role: 'system', content: 'You are Auma.' }, { role: 'user', content: '{}' }], tools: CLOUD_WAKE_REPO_TOOLS, fetchImpl })
  assert.equal(sent[0].url, 'https://api.anthropic.com/v1/messages')
  assert.deepEqual(sent[0].body.tools.map(item => item.name), ['readRepoFile', 'searchRepository', 'recentCommits'])
  assert.equal(out.ok, true)
  assert.deepEqual(out.message.tool_calls, [{ id: 'toolu_9', type: 'function', function: { name: 'recentCommits', arguments: '{}' } }])
  const run = await runCloudWakeRepoTool(out.message.tool_calls[0].function.name, JSON.parse(out.message.tool_calls[0].function.arguments),
    { env: {}, seedId: SEED, read: async () => ({ ok: true, commits: [{ sha: sha(4), message: 'feat: x\n\nbody' }] }) })
  assert.deepEqual(run, { ok: true, commits: [{ sha: sha(4).slice(0, 12), subject: 'feat: x' }] })
})
