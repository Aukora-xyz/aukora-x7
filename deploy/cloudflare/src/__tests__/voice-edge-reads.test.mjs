/**
 * Each edge-brokered read her voice may call is proven a READ at the edge.
 *
 * For every v1 row of the look-only switch table (webworker-runtime/src/x6/voice-read-only.ts) this file sends the EXACT
 * request her worker sends for that row (route, method, body; file:line of ball-loader.ts / host-facts.ts beside each row)
 * through the REAL Worker, the REAL HEAD and Mirror Durable Objects and the real cloud brokers, over in-memory storage
 * that records every write, with a fake outward network that records every call. Each row asserts:
 *   - no storage put, delete, alarm change or transaction write of ANY key, in HEAD or Mirror;
 *   - no outward call except a GET to the fixed host that row names (none at all for most rows);
 *   - no ambient `fetch` from any object (stubbed to record and fail);
 *   - the answer's shape.
 * Every row runs with a STALE RUNNING TURN in HEAD (heartbeat two minutes old): the reap at head-do.mjs:2414-2422 is the
 * trap M2 found. A row whose request reaches that reap writes `head:turn:active`, fails here, and stays off. The
 * last tests are the controls: the two R2 rows (`x6_repo transcript read`, `x6_wish status`) DO write through this same
 * harness, which proves it can see the trap.
 * Made-up content only; no network, no credential, no private folder of hers.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { createWorker } from '../worker.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'
import { provisionMessagesIdentity, MESSAGES_STORAGE_KEY } from '../messages-store.mjs'

const ORIGIN = 'https://voice-edge-reads.example.invalid'
const OWNER = 'owner@example.invalid'
const REPO = 'your_org_x/your-node'
const GH = `/repos/${REPO}`
const COMMIT = 'a'.repeat(40), PARENT = 'e'.repeat(40), TREE = 'b'.repeat(40), BLOB = 'c'.repeat(40)
/** A commit on main's history that is not main (review SHOULD 3: /commits/<non-main sha> and /compare/<sha>...main). */
const OLDER = 'd'.repeat(40)
const CF_ACCOUNT = 'f'.repeat(32)
const STALE_TURN = 'stale-voice-trap-turn'
const REAL_FETCH = globalThis.fetch
const SOURCES = Object.freeze({ 'README.md': '# made-up readme\nvoice reads here\n', 'docs/guide.md': '# made-up guide\nnothing secret\n',
  'packages/demo/a.ts': 'export const voice = "made-up"\n' })

/** A made-up memory DAG of one node and the receipts.v3 chain that anchors it, by the mirror's rules (mirror-do.mjs:1025-1075;
 * as nostr-anchor-door.test.mjs): node id = sha256(canonicalJson(node without id)), leafHash = sha256(0x00 || row). */
function madeUpMemory() {
  const sha = text => createHash('sha256').update(text).digest('hex')
  const body = { content: 'made-up memory', parentIds: [] }
  const node = { id: sha(canonicalJson(body)), ...body }
  let previous = '0'.repeat(64), text = ''
  const rows = [['head.stage', { epoch: 4 }], ['memory.dag.append', { nodeId: node.id }], ['head.stage', { epoch: 4 }]]
  rows.forEach(([kind, data], index) => {
    const row = { schema: 'aukora.receipt.v3', seq: index + 1, at: `2026-11-13T00:00:0${index + 1}.000Z`, kind, data, prevHash: previous }
    row.leafHash = sha('\0' + canonicalJson(row))
    previous = row.leafHash
    text += JSON.stringify(row) + '\n'
  })
  return { node, receipts: text }
}

/** In-memory DO storage (as nostr-anchor-door.test.mjs) that records every write, in place and inside transactions. */
function recordedStorage(object, writes) {
  let data = new Map(), alarm = null, tail = Promise.resolve()
  const note = (op, key) => writes.push({ object, op, key: key === undefined ? null : String(key) })
  const view = (rows, timer) => ({
    get: async key => structuredClone(rows.get(key)),
    put: async (key, value) => { note('put', key); rows.set(key, structuredClone(value)) },
    delete: async key => { note('delete', key); return rows.delete(key) },
    deleteAll: async () => { note('deleteAll'); rows.clear() },
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...rows].filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit))),
    getAlarm: async () => timer.value,
    setAlarm: async value => { note('setAlarm'); timer.value = value },
    deleteAlarm: async () => { note('deleteAlarm'); timer.value = null },
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'deleteAll', 'list', 'setAlarm', 'deleteAlarm'].map(method =>
    [method, (...args) => { const timer = { value: alarm }; const out = view(data, timer)[method](...args); return out.then(value => { alarm = timer.value; return value }) }]))
  storage.getAlarm = async () => alarm
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const rows = structuredClone(data), timer = { value: alarm }
      const value = await operation(view(rows, timer))
      data = rows; alarm = timer.value
      return value
    })
    tail = result.catch(() => {})
    return result
  }
  return { storage, snapshot: () => structuredClone(data) }
}

/** The fake GitHub and Cloudflare APIs: GET only, fixed answers, made-up bytes. Anything else is recorded and refused. */
function upstream(url, init) {
  const target = new URL(url)
  if (init.method !== 'GET') return Response.json({ message: 'fixture refuses non-GET' }, { status: 405 })
  if (target.hostname === 'pipelines.blob.core.windows.net') return new Response('made-up job log line\n', { status: 200 })
  if (target.hostname === 'api.cloudflare.com') {
    return Response.json({ success: true, result: { items: [{ id: 'version-1', metadata: { created_on: '2026-11-13T00:00:00Z' } }] } })
  }
  if (target.hostname !== 'api.github.com') return Response.json({}, { status: 404 })
  const path = target.pathname, tree = () => ({ sha: TREE, truncated: false, tree: [
    { path: 'docs', mode: '040000', type: 'tree', sha: TREE }, { path: 'packages', mode: '040000', type: 'tree', sha: TREE },
    { path: 'packages/demo', mode: '040000', type: 'tree', sha: TREE },
    ...Object.entries(SOURCES).map(([file, text]) => ({ path: file, mode: '100644', type: 'blob', sha: BLOB, size: Buffer.byteLength(text) }))] })
  const commit = (sha, message) => ({ sha, commit: { message, tree: { sha: TREE } }, parents: [{ sha: PARENT }] })
  if (path === GH) return Response.json({ full_name: REPO, default_branch: 'main', private: true })
  if (path === `${GH}/commits/main` || path === `${GH}/commits/${COMMIT}` || decodeURIComponent(path) === `${GH}/commits/auma/sandbox/voice-check`) return Response.json(commit(COMMIT, 'made-up head commit'))
  if (path === `${GH}/commits/${OLDER}`) return Response.json(commit(OLDER, 'made-up older commit'))
  // OLDER is one commit behind main: the one bounded comparison that proves ancestry (cloud-brokers.mjs mainComparison).
  if (path === `${GH}/compare/${OLDER}...${COMMIT}`) {
    return Response.json({ status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: OLDER }, merge_base_commit: { sha: OLDER },
      files: [{ filename: 'docs/guide.md', status: 'modified', patch: '@@ -1 +1 @@\n-# made-up\n+# made-up guide' }] })
  }
  if (path === `${GH}/commits`) {
    const n = Number(target.searchParams.get('per_page') ?? 10)
    return Response.json([commit(COMMIT, 'made-up head commit'), commit(PARENT, 'made-up parent')].slice(0, n))
  }
  if (path === `${GH}/git/trees/${TREE}` || path === `${GH}/git/trees/main`) return Response.json(tree())
  if (path.startsWith(`${GH}/contents/`)) {
    const file = decodeURIComponent(path.slice(`${GH}/contents/`.length))
    if (!Object.hasOwn(SOURCES, file)) return Response.json({}, { status: 404 })
    return Response.json({ type: 'file', path: file, sha: BLOB, encoding: 'base64', content: Buffer.from(SOURCES[file]).toString('base64') })
  }
  const issue = { id: 7, number: 3, state: 'open', title: 'made-up issue', body: null, html_url: `https://github.com/${REPO}/issues/3` }
  const run = { id: 99, name: 'deploy-x61', head_sha: COMMIT, status: 'completed', conclusion: 'success', head_branch: 'main', html_url: `https://github.com/${REPO}/actions/runs/99` }
  if (path === `${GH}/issues`) return Response.json([issue])
  if (path === `${GH}/issues/3`) return Response.json(issue)
  if (path === `${GH}/pulls`) return Response.json([{ id: 8, number: 4, state: 'open', title: 'made-up pull', body: 'made-up', html_url: `https://github.com/${REPO}/pull/4` }])
  if (path === `${GH}/issues/3/comments`) {
    return Response.json([{ id: 11, body: 'made-up comment', html_url: `https://github.com/${REPO}/issues/3#issuecomment-11`, issue_url: `https://api.github.com${GH}/issues/3` }])
  }
  if (path === `${GH}/actions/runs/99`) return Response.json(run)
  if (path === `${GH}/actions/runs/99/jobs`) {
    return Response.json({ total_count: 1, jobs: [{ id: 42, run_id: 99, name: 'made-up job', status: 'completed', conclusion: 'failure',
      steps: [{ number: 1, name: 'made-up step', status: 'completed', conclusion: 'failure' }] }] })
  }
  if (path === `${GH}/actions/runs`) {
    return Response.json({ total_count: 1, workflow_runs: [run] })
  }
  if (path === `${GH}/actions/jobs/42/logs`) {
    return new Response(null, { status: 302, headers: { location: 'https://pipelines.blob.core.windows.net/logs/42.txt?sig=made-up-signature' } })
  }
  return Response.json({ message: 'not in fixture' }, { status: 404 })
}

async function stack(t) {
  const writes = [], calls = [], ambient = []
  const hs = recordedStorage('HEAD', writes), ms = recordedStorage('MIRROR', writes)
  const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: OWNER,
    OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), SOURCE_REVISION: COMMIT, GITHUB_TOKEN: 'synthetic-github-fixture-value',
    CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-fixture-value', CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT }
  const head = new X61HeadDurableObject({ storage: hs.storage, getWebSockets: () => [] }, env)
  t.after(() => head.wakeStore.dispose())
  const mirror = new MirrorDO({ storage: ms.storage }, env)
  env.HEAD = { idFromName: name => name, get: () => ({ fetch: request => head.fetch(request) }) }
  env.MIRROR = { idFromName: name => name, get: () => ({ fetch: request => mirror.fetch(request) }) }
  // Any fetch an object makes on its own (not through the Worker's injected networkFetch) is recorded and fails.
  globalThis.fetch = async url => { ambient.push(String(url?.url ?? url)); throw new Error('ambient network is forbidden here') }
  t.after(() => { globalThis.fetch = REAL_FETCH })
  const networkFetch = async (url, init = {}) => {
    const headers = new Headers(init.headers)
    calls.push({ host: new URL(url).hostname, method: init.method ?? 'GET', path: new URL(url).pathname, authorized: headers.has('authorization') })
    return upstream(url, { ...init, method: init.method ?? 'GET' })
  }
  const worker = createWorker({ verifyAccess: async () => access, networkFetch })
  /** One request as her page's worker sends it: same-origin fetch with the owner session. A GET carries no Origin header. */
  const send = async (method, path, body) => {
    const response = await worker.fetch(new Request(ORIGIN + path, { method,
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
        ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env)
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { json = { unparsed: text.slice(0, 200) } }
    return { status: response.status, body: json }
  }
  // Bootstrap: a made-up ball and a made-up home in Mirror (writes here are setup, before any row is watched).
  const code = 'export const fixture = true;\n', moduleSha = await digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 4, parentBallId: null, createdAt: '2026-11-13T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}`, size: Buffer.byteLength(code) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const file = text => ({ kind: 'file', mode: 0o600, mtimeMs: 1, b64: Buffer.from(text).toString('base64') })
  const dir = { kind: 'dir', mode: 0o700 }
  const memory = madeUpMemory()
  const entries = [['/dsh/home/auma', dir],
    ['/dsh/home/auma/HANDOFF.md', file(`| epoch | **${ball.epoch}** |\n| ballId | \`${ball.ballId}\` |\nmade-up hand-off\n`)],
    ['/dsh/home/auma/memory', dir], ['/dsh/home/auma/memory/dag', dir],
    ['/dsh/home/auma/memory/dag/HEAD.json', file(JSON.stringify({ heads: [memory.node.id], count: 1 }))],
    [`/dsh/home/auma/memory/dag/${memory.node.id}.json`, file(JSON.stringify(memory.node))],
    ['/dsh/home/auma/private', dir], ['/dsh/home/auma/private/made-up.md', file('made-up private line')],
    ['/dsh/home/auma/seed', dir], ['/dsh/home/auma/seed/checkpoints.v1.jsonl', file('')], ['/dsh/home/auma/seed/discovery-corpus.v1.jsonl', file('')],
    ['/dsh/home/auma/seed/receipts.v3.jsonl', file(memory.receipts)],
    ['/dsh/home/auma/superagent', dir], ['/dsh/home/auma/superagent/state.json', file(JSON.stringify({ assignments: [] }))]]
  const payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [moduleSha]: code }, mirror: { entryCount: entries.length, batchDigests: [await digest(canonicalBootstrap(entries))] } }
  const prepared = await send('POST', '/_bootstrap', { action: 'prepare', package: payload })
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
  const { seedId } = prepared.body
  assert.equal((await send('POST', '/_bootstrap', { action: 'batch', seedId, index: 0, entries })).status, 200)
  assert.equal((await send('POST', '/_bootstrap', { action: 'commit', seedId })).status, 200)
  // What is staged and waiting for him: one Pearl staged on HEAD (as head-staged-settled.test.mjs stages it).
  const organCode = 'export const bodyMap = "made-up";\n', organSha = await digest(organCode)
  const next = { ...ball, epoch: ball.epoch + 1, parentBallId: ball.ballId, createdAt: '2026-11-13T00:01:00.000Z',
    entries: { ...ball.entries, 'auma-body-map': { id: 'auma-body-map', specifier: `ball:${organSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { ...ball.modules, [organSha]: { sha256: organSha, specifier: `ball:${organSha}`, size: Buffer.byteLength(organCode) } } }
  delete next.ballId
  const candidate = { ball: { ...next, ballId: await manifestIdCanon(next) }, codeBySha: { [organSha]: organCode },
    expectedParentBallId: ball.ballId, expectedEpoch: ball.epoch }
  const staged = await send('POST', '/_head/stage', candidate)
  assert.equal(staged.status, 200, JSON.stringify(staged.body))
  // THE TRAP: a running turn whose heartbeat is two minutes old, as a closed tab leaves it.
  const stale = { turn_id: STALE_TURN, status: 'running', tab_id: 'made-up-tab', started_at: Date.now() - 180000, heartbeat_at: Date.now() - 120000 }
  await hs.storage.put('head:turn:active', stale)
  await hs.storage.put(`head:turn-journal:turn:${STALE_TURN}`, { turnId: STALE_TURN, state: 'dispatched' })
  /** Run `act` and return exactly what it wrote and called. */
  const watch = async act => {
    const w = writes.length, c = calls.length, a = ambient.length
    const before = { head: hs.snapshot(), mirror: ms.snapshot() }
    const answer = await act()
    return { answer, writes: writes.slice(w), calls: calls.slice(c), ambient: ambient.slice(a),
      before, after: { head: hs.snapshot(), mirror: ms.snapshot() } }
  }
  return { send, watch, hs, ms, head, ball, candidate, seedId, stale, writes, calls }
}

/** The row's proof: nothing written, nothing sent but GETs to `hosts`, the stale turn still running untouched. */
function provenRead(fx, seen, hosts = [], label = '') {
  assert.deepEqual(seen.writes, [], `${label}: no storage write of any key`)
  assert.deepEqual(seen.after, seen.before, `${label}: HEAD and Mirror storage byte-for-byte unchanged`)
  assert.deepEqual(seen.ambient, [], `${label}: no ambient fetch`)
  for (const call of seen.calls) {
    assert.equal(call.method, 'GET', `${label}: outward ${call.method} ${call.host}${call.path}`)
    assert.ok(hosts.includes(call.host), `${label}: outward call to ${call.host} is not a host this row names`)
  }
}

async function staleTurnUntouched(fx) {
  assert.deepEqual(await fx.hs.storage.get('head:turn:active'), fx.stale, 'the stale running turn is not reaped')
}

// ── Row 1. x6_host_facts: three same-origin GETs (host-facts.ts:144, sources :19-24). Handlers: worker.mjs:2084 forward ->
// head-do.mjs:2376-2393 (promotion-status); worker.mjs:2075-2076 -> head-do.mjs:2214-2234 (aumlok status);
// worker.mjs:2082 -> head-do.mjs:2328-2353 (facts, reading Mirror's aura inputs).
test('x6_host_facts: GET /_head/promotion-status, /_host/aumlok/status and /__x6/facts write nothing and call nothing outward', async t => {
  const fx = await stack(t)
  const promotion = await fx.watch(() => fx.send('GET', '/_head/promotion-status'))
  provenRead(fx, promotion, [], 'promotion-status')
  assert.equal(promotion.answer.status, 200, JSON.stringify(promotion.answer.body))
  assert.equal(promotion.answer.body.ok, true)
  assert.equal(promotion.answer.body.ballId, fx.ball.ballId)
  assert.equal(promotion.answer.body.staged.ballId, fx.candidate.ball.ballId, 'what is staged and waiting for him is named')
  const aumlok = await fx.watch(() => fx.send('GET', '/_host/aumlok/status'))
  provenRead(fx, aumlok, [], 'aumlok status')
  assert.equal(aumlok.answer.status, 200, JSON.stringify(aumlok.answer.body))
  assert.equal(aumlok.answer.body.ok, true)
  assert.ok(['BOUND', 'UNBOUND'].includes(aumlok.answer.body.phase))
  const facts = await fx.watch(() => fx.send('GET', '/__x6/facts'))
  provenRead(fx, facts, [], '__x6/facts')
  assert.equal(facts.answer.status, 200, JSON.stringify(facts.answer.body))
  assert.equal(facts.answer.body.ok, true)
  assert.equal(facts.answer.body.epoch, fx.ball.epoch)
  assert.equal(facts.answer.body.receiptsVerified, 3)
  await staleTurnUntouched(fx)
})

// ── Rows 1-2, the one accepted write. When the staged record names a Pearl that
// landed and HEAD has since moved past it, and an older build left that record unmarked, GET /_head/promotion-status marks
// it once (head-do.mjs readStaged :1110-1118: `publishedEpoch`, idempotent bookkeeping the page's own reads already cause).
// Exactly that one put, of exactly that key, adding exactly `publishedEpoch`; a second read writes nothing.
test('promotion-status on an unmarked published ancestor: exactly one put of head:staged-promotion adding publishedEpoch, then none', async t => {
  const fx = await stack(t)
  // Setup (unwatched), through HEAD's own routes as head-staged-settled.test.mjs does: land the staged Pearl, take its mark
  // away to stand for the record an older build left, then publish one more Pearl directly so the record is an ancestor.
  fx.head.aumlokStore = { consumeApprovalInTransaction: async () => ({ ok: true, expiresAt: Date.now() + 60000 }) }
  const internal = async (path, body, extra = {}) => {
    const response = await fx.head.fetch(new Request(ORIGIN + path, { method: 'POST',
      headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': fx.seedId, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
        'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }), ...extra },
      body: JSON.stringify(body) }))
    return { status: response.status, body: await response.json() }
  }
  const promoted = await internal('/_head/promote', { ballId: fx.candidate.ball.ballId }, { 'x-x6-class3-approval': 'approved' })
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body))
  const { publishedEpoch: _mark, ...unmarked } = await fx.hs.storage.get('head:staged-promotion')
  await fx.hs.storage.put('head:staged-promotion', unmarked)
  const parent = fx.candidate.ball, code = 'export const bodyMap = "made-up next";\n', sha = await digest(code)
  const next = { ...parent, epoch: parent.epoch + 1, parentBallId: parent.ballId, createdAt: '2026-11-13T00:02:00.000Z',
    entries: { ...parent.entries, 'auma-body-map': { ...parent.entries['auma-body-map'], specifier: `ball:${sha}` } },
    modules: { ...parent.modules, [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(code) } } }
  delete next.ballId
  const following = { ball: { ...next, ballId: await manifestIdCanon(next) }, codeBySha: { [sha]: code }, expectedParentBallId: parent.ballId, expectedEpoch: parent.epoch }
  const { lease } = await fx.head.store.lease({ action: 'acquire', ownerPeerId: following.ball.authorPeerId })
  const published = await internal('/_head/ball', { ...following, writerLease: lease }, { 'x-x6-class3-approval': 'approved' })
  assert.equal(published.status, 200, JSON.stringify(published.body))
  await fx.head.store.lease({ action: 'release', ownerPeerId: lease.ownerPeerId, generation: lease.generation })
  assert.equal((await fx.hs.storage.get('head:staged-promotion')).publishedEpoch, undefined, 'the record is unmarked before the read')
  // The read her voice makes (x6_host_facts, x6_repo promotion_status), through the Worker.
  const first = await fx.watch(() => fx.send('GET', '/_head/promotion-status'))
  assert.equal(first.answer.status, 200, JSON.stringify(first.answer.body))
  assert.deepEqual([first.answer.body.supersededStaged.ballId, first.answer.body.supersededStaged.state], [fx.candidate.ball.ballId, 'published'])
  assert.deepEqual(first.writes, [{ object: 'HEAD', op: 'put', key: 'head:staged-promotion' }], 'exactly one put, of exactly that key')
  const { 'head:staged-promotion': markedAfter, ...restAfter } = Object.fromEntries(first.after.head)
  const { 'head:staged-promotion': markedBefore, ...restBefore } = Object.fromEntries(first.before.head)
  assert.deepEqual(markedAfter, { ...markedBefore, publishedEpoch: fx.candidate.ball.epoch }, 'it adds exactly publishedEpoch')
  assert.deepEqual(restAfter, restBefore, 'no other HEAD key changes')
  assert.deepEqual(first.after.mirror, first.before.mirror, 'Mirror unchanged')
  assert.deepEqual(first.calls, [], 'no outward call')
  assert.deepEqual(first.ambient, [], 'no ambient fetch')
  const second = await fx.watch(() => fx.send('GET', '/_head/promotion-status'))
  provenRead(fx, second, [], 'promotion-status, second read')
  assert.deepEqual(second.answer.body.supersededStaged, first.answer.body.supersededStaged)
  await staleTurnUntouched(fx)
})

// ── Row 2. x6_repo promotion_status: ball-loader.ts:6493 -> :5317-5389 reads her staged VFS folder locally, then GET
// /_head/promotion-status (:5360), else GET /_head/lease (:5363). Handlers: worker.mjs:2084 -> head-do.mjs:2376 / :2375.
test('x6_repo promotion_status: its GET /_head/promotion-status and fallback GET /_head/lease write nothing', async t => {
  const fx = await stack(t)
  const status = await fx.watch(() => fx.send('GET', '/_head/promotion-status'))
  provenRead(fx, status, [], 'promotion-status')
  assert.equal(status.answer.body.staged.ballId, fx.candidate.ball.ballId)
  const lease = await fx.watch(() => fx.send('GET', '/_head/lease'))
  provenRead(fx, lease, [], 'lease')
  assert.equal(lease.answer.status, 200, JSON.stringify(lease.answer.body))
  assert.equal(lease.answer.body.ballId, fx.ball.ballId)
  await staleTurnUntouched(fx)
})

// ── Rows 3-7. x6_repo status / read / search / log / tree: POST /_host/repo with the arguments (ball-loader.ts:6510-6516,
// :6587-6594; `action` is copied unchanged for these actions). Handler: worker.mjs:2073 -> cloud-brokers.mjs:1718 ->
// repo() :1154 (status :1182, read :1186, search :755, log :1208, tree :1178).
test('x6_repo status / read / search / log / tree: each POST /_host/repo writes nothing and reaches only GETs to api.github.com', async t => {
  const fx = await stack(t)
  const github = ['api.github.com']
  const status = await fx.watch(() => fx.send('POST', '/_host/repo', { action: 'status' }))
  provenRead(fx, status, [], 'status')
  assert.equal(status.answer.status, 200, JSON.stringify(status.answer.body))
  assert.equal(status.answer.body.head.ballId, fx.ball.ballId)
  assert.equal(status.answer.body.githubConfigured, true)
  const readGithub = await fx.watch(() => fx.send('POST', '/_host/repo', { action: 'read', path: 'README.md' }))
  provenRead(fx, readGithub, github, 'read github')
  assert.equal(readGithub.answer.status, 200, JSON.stringify(readGithub.answer.body))
  assert.equal(readGithub.answer.body.content, SOURCES['README.md'])
  const readRange = await fx.watch(() => fx.send('POST', '/_host/repo', { action: 'read', path: 'README.md', offset: 2, length: 4 }))
  provenRead(fx, readRange, github, 'read range')
  assert.equal(readRange.answer.body.content, SOURCES['README.md'].slice(2, 6))
  const readMirror = await fx.watch(() => fx.send('POST', '/_host/repo', { action: 'read', path: 'mirror/home/auma/HANDOFF.md' }))
  provenRead(fx, readMirror, [], 'read mirror')
  assert.equal(readMirror.answer.status, 200, JSON.stringify(readMirror.answer.body))
  assert.equal(readMirror.answer.body.source, 'mirror')
  assert.match(readMirror.answer.body.content, /made-up hand-off/)
  // Her private folder is refused by the edge before any read (privatePart and canonicalPath, cloud-brokers.mjs:26, :34-35).
  const privateRead = await fx.watch(() => fx.send('POST', '/_host/repo', { action: 'read', path: 'mirror/home/auma/private/made-up.md' }))
  provenRead(fx, privateRead, [], 'read private')
  assert.equal(privateRead.answer.status, 403)
  assert.equal(JSON.stringify(privateRead.answer.body).includes('made-up private line'), false)
  const search = await fx.watch(() => fx.send('POST', '/_host/repo', { action: 'search', query: 'voice' }))
  provenRead(fx, search, github, 'search')
  assert.equal(search.answer.status, 200, JSON.stringify(search.answer.body))
  assert.deepEqual(search.answer.body.matches.map(match => match.path).sort(), ['README.md', 'packages/demo/a.ts'])
  const log = await fx.watch(() => fx.send('POST', '/_host/repo', { action: 'log', limit: 2 }))
  provenRead(fx, log, github, 'log')
  assert.equal(log.answer.status, 200, JSON.stringify(log.answer.body))
  assert.deepEqual(log.answer.body.commits.map(commit => commit.sha), [COMMIT, PARENT])
  const tree = await fx.watch(() => fx.send('POST', '/_host/repo', { action: 'tree', prefix: 'docs' }))
  provenRead(fx, tree, github, 'tree')
  assert.equal(tree.answer.status, 200, JSON.stringify(tree.answer.body))
  assert.deepEqual(tree.answer.body.entries.map(entry => entry.path), ['docs', 'docs/guide.md'])
  await staleTurnUntouched(fx)
})

// S1: the verdict selects these rows by `action` only, so every other argument her tool takes rides along. Each
// read action is sent again carrying EVERY x6_repo parameter (ball-loader.ts:6396-6462) with a write-shaped value: the edge
// action stays the read (or the edge refuses the request), and still nothing is written and nothing but a GET leaves.
test('x6_repo reads carrying every other x6_repo argument still write nothing and send nothing but GETs', async t => {
  const fx = await stack(t)
  const extras = { path: 'docs/guide.md', dryRun: false, subAction: 'append', role: 'user', turn_id: 'voice-turn', call_id: 'voice-call',
    takeover: true, prefix: 'docs', branch: 'main', fromSha: COMMIT, query: 'guide', regex: false, caseSensitive: false, maxMatches: 5,
    leftPath: 'README.md', rightPath: 'docs/guide.md', leftSource: 'github', rightSource: 'github', ref: 'main', contextLines: 1,
    title: 'from voice', summary: 'from voice', baseSha: COMMIT, headSha: COMMIT, treeSha: TREE, expectedHeadSha: COMMIT, offset: 0, length: 4,
    base: COMMIT, limit: 1, content: 'written from voice', oldString: 'guide', newString: 'GUIDE', message: 'from voice',
    changes: [{ path: 'docs/guide.md', content: 'written from voice' }], workflow: 'deploy-x61.yml', paths: ['docs/guide.md'],
    command: 'rm -rf /', ownerSession: true, idempotencyKey: 'voice-key' }
  for (const action of ['status', 'read', 'search', 'log', 'tree']) {
    for (const branch of ['main', 'auma/sandbox/voice-check']) {
      const seen = await fx.watch(() => fx.send('POST', '/_host/repo', { ...extras, branch, action }))
      provenRead(fx, seen, ['api.github.com'], `${action} on ${branch} with every argument`)
      assert.notEqual(seen.answer.body.committed, true)
      assert.equal(JSON.stringify(seen.answer.body).includes('written from voice'), false, `${action}: nothing it was handed comes back as written`)
    }
  }
  // The same reads with only the fields each edge read accepts, write-shaped where they can be (`ownerSession`, a branch
  // of hers): they are served, and still nothing is written and nothing but a GET leaves.
  const accepted = [
    [{ action: 'status', ownerSession: true, idempotencyKey: 'voice-key', expectedHeadSha: COMMIT, content: 'written from voice' }, 200],
    [{ action: 'read', path: 'README.md', offset: 0, length: 4, branch: 'main', ownerSession: true }, 200],
    [{ action: 'read', path: 'README.md', branch: 'auma/sandbox/voice-check', ownerSession: true }, 200],
    [{ action: 'search', query: 'voice', regex: false, caseSensitive: true, prefix: 'packages', maxMatches: 2, branch: 'main' }, 200],
    [{ action: 'search', query: 'voice', branch: 'auma/sandbox/voice-check' }, 200],
    [{ action: 'log', limit: 1, ownerSession: true, content: 'written from voice', message: 'from voice' }, 200],
    [{ action: 'tree', prefix: 'docs' }, 200],
  ]
  for (const [body, status] of accepted) {
    const seen = await fx.watch(() => fx.send('POST', '/_host/repo', body))
    provenRead(fx, seen, ['api.github.com'], JSON.stringify(body))
    assert.equal(seen.answer.status, status, `${JSON.stringify(body)}: ${JSON.stringify(seen.answer.body)}`)
    assert.equal(JSON.stringify(seen.answer.body).includes('written from voice'), false)
  }
  await staleTurnUntouched(fx)
})

// ── Rows 8-9. x6_github status and api class 0: POST /_host/github with the arguments unchanged (ball-loader.ts:6979-6984).
// Class 0 is ball-loader.ts:616-631 (GET, no body, no `args`, this repository). Handler: worker.mjs:2073 ->
// cloud-brokers.mjs:1540 githubBroker (status :1541-1543; GET dispatch :1557-1626).
test('x6_github status and class-0 api GETs write nothing; outward only GETs to api.github.com (job logs: one GitHub-named blob GET)', async t => {
  const fx = await stack(t)
  const status = await fx.watch(() => fx.send('POST', '/_host/github', { action: 'status' }))
  provenRead(fx, status, [], 'github status')
  assert.equal(status.answer.status, 200, JSON.stringify(status.answer.body))
  assert.equal(status.answer.body.action, 'status')
  // The status branch returns before `method`, `endpoint` or `body` are read: write-shaped extras change nothing.
  const statusExtras = await fx.watch(() => fx.send('POST', '/_host/github', { action: 'status', method: 'POST',
    endpoint: `repos/${REPO}/issues`, body: { title: 'from voice' }, args: ['issue', 'create'] }))
  provenRead(fx, statusExtras, [], 'github status with extras')
  assert.equal(statusExtras.answer.body.action, 'status')
  for (const [endpoint, check] of [
    [`repos/${REPO}`, json => assert.equal(json.full_name, REPO)],
    [`repos/${REPO}/commits?per_page=2`, json => assert.deepEqual(json.map(commit => commit.sha), [COMMIT, PARENT])],
    [`repos/${REPO}/contents/README.md`, json => assert.equal(json.content, SOURCES['README.md'])],
    [`repos/${REPO}/issues?state=open`, json => assert.equal(json.items[0].title, 'made-up issue')],
    [`repos/${REPO}/actions/runs?per_page=1`, json => assert.equal(json.items[0].conclusion, 'success')],
    [`repos/${REPO}/git/trees/main?recursive=1`, json => assert.ok(json.entries.some(entry => entry.path === 'README.md'))],
    // Review SHOULD 3: the seven other GET shapes the broker serves (cloud-brokers.mjs githubBroker), one fixture answer each.
    [`repos/${REPO}/pulls?state=open`, json => assert.deepEqual(json.items.map(item => [item.kind, item.number]), [['pull', 4]])],
    [`repos/${REPO}/issues/3`, json => assert.deepEqual([json.kind, json.number, json.title], ['issue', 3, 'made-up issue'])],
    [`repos/${REPO}/issues/3/comments`, json => assert.deepEqual(json.items.map(item => [item.issueNumber, item.body]), [[3, 'made-up comment']])],
    [`repos/${REPO}/compare/${OLDER}...main`, json => assert.deepEqual([json.base, json.head, json.files.map(file => file.path)], [OLDER, COMMIT, ['docs/guide.md']])],
    [`repos/${REPO}/commits/${OLDER}`, json => assert.deepEqual([json.sha, json.message], [OLDER, 'made-up older commit'])],
    [`repos/${REPO}/actions/runs/99`, json => assert.deepEqual([json.id, json.conclusion], [99, 'success'])],
    [`repos/${REPO}/actions/runs/99/jobs`, json => assert.deepEqual(json.items.map(job => [job.id, job.conclusion, job.steps.length]), [[42, 'failure', 1]])],
  ]) {
    const seen = await fx.watch(() => fx.send('POST', '/_host/github', { action: 'api', endpoint }))
    provenRead(fx, seen, ['api.github.com'], endpoint)
    assert.ok(seen.calls.length > 0 && seen.calls.every(call => call.authorized), `${endpoint}: reached GitHub with its server-side credential only`)
    assert.equal(seen.answer.status, 200, `${endpoint}: ${JSON.stringify(seen.answer.body)}`)
    assert.equal(seen.answer.body.method, 'GET')
    check(seen.answer.body.json)
  }
  // Job logs: GitHub answers 302 to its own signed log object; the edge fetches it once, a GET, with no credential
  // (cloud-brokers.mjs:1512-1523, host pinned to *.blob.core.windows.net). The only second host any class-0 call reaches,
  // so it is OFF for voice (voice-read-only.ts x6_github api argPatterns); a typed thread still reads it.
  const logs = await fx.watch(() => fx.send('POST', '/_host/github', { action: 'api', endpoint: `repos/${REPO}/actions/jobs/42/logs` }))
  provenRead(fx, logs, ['api.github.com', 'pipelines.blob.core.windows.net'], 'job logs')
  assert.equal(logs.answer.status, 200, JSON.stringify(logs.answer.body))
  assert.match(logs.answer.body.json.log, /made-up job log line/)
  assert.deepEqual(logs.calls.map(call => [call.host, call.authorized]), [['api.github.com', true], ['pipelines.blob.core.windows.net', false]])
  await staleTurnUntouched(fx)
})

// ── Rows 10-11. x6_cloudflare status / versions: POST /_host/cloudflare with the arguments unchanged (ball-loader.ts:7021-7026).
// Handler: worker.mjs:2073 -> cloud-brokers.mjs:1695 cloudflareBroker (status :1697; versions :1698-1709).
test('x6_cloudflare status and versions write nothing; versions remote:true is one GET to api.cloudflare.com', async t => {
  const fx = await stack(t)
  for (const body of [{ action: 'status' }, { action: 'versions' }, { action: 'status', args: ['deploy'], cwd: '.', remote: true },
    { action: 'versions', args: ['deploy'], cwd: '.' }]) {
    const seen = await fx.watch(() => fx.send('POST', '/_host/cloudflare', body))
    provenRead(fx, seen, [], JSON.stringify(body))
    assert.equal(seen.answer.status, 200, JSON.stringify(seen.answer.body))
    assert.equal(seen.answer.body.action, body.action)
    assert.deepEqual(seen.calls, [])
  }
  const remote = await fx.watch(() => fx.send('POST', '/_host/cloudflare', { action: 'versions', remote: true }))
  provenRead(fx, remote, ['api.cloudflare.com'], 'versions remote')
  assert.equal(remote.answer.status, 200, JSON.stringify(remote.answer.body))
  assert.deepEqual(remote.answer.body.versions, [{ id: 'version-1', createdOn: '2026-11-13T00:00:00Z' }])
  assert.deepEqual(remote.calls.map(call => [call.host, call.method, call.path]),
    [['api.cloudflare.com', 'GET', `/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/your-node/versions`]])
  await staleTurnUntouched(fx)
})

// ── Row 12. x6_nostr status: POST /_head/transcript with the FIXED body { action: 'nostr_status' } whatever the arguments
// (ball-loader.ts:7303-7309). Handler: worker.mjs:2084 forward -> head-do.mjs:2411-2413, which answers BEFORE the
// transaction that reaps (:2414-2422); readMessagesStatus (messages-store.mjs:378-388) reads in a transaction, writes nothing.
test('x6_nostr status: POST /_head/transcript nostr_status skips the reap and writes nothing, with and without her identity', async t => {
  const fx = await stack(t)
  const empty = await fx.watch(() => fx.send('POST', '/_head/transcript', { action: 'nostr_status' }))
  provenRead(fx, empty, [], 'nostr status (no identity)')
  assert.equal(empty.answer.status, 200, JSON.stringify(empty.answer.body))
  assert.deepEqual(empty.answer.body.nostr.identity, { npub: null, pubkey: null, signing: 'unavailable' })
  await provisionMessagesIdentity(fx.hs.storage, { approved: true })
  const stored = await fx.hs.storage.get(MESSAGES_STORAGE_KEY)
  const provisioned = await fx.watch(() => fx.send('POST', '/_head/transcript', { action: 'nostr_status' }))
  provenRead(fx, provisioned, [], 'nostr status (identity)')
  assert.match(provisioned.answer.body.nostr.identity.npub, /^npub1/)
  assert.equal(JSON.stringify(provisioned.answer).includes(stored.identity.secretKey), false, 'her Nostr secret never leaves')
  await staleTurnUntouched(fx)
})

// ── Controls: the harness sees the trap. The two R2 rows, sent exactly as her worker sends them, DO write at the edge.
test('control: x6_repo transcript read and x6_wish status reap the stale turn here, so they stay off', async t => {
  const fx = await stack(t)
  // x6_repo transcript read: POST /_head/transcript { ...args, action: 'read', tab_id } (ball-loader.ts:6266-6278).
  const transcript = await fx.watch(() => fx.send('POST', '/_head/transcript', { action: 'read', subAction: 'read', limit: 5, tab_id: 'made-up-peer' }))
  assert.ok(transcript.writes.some(write => write.object === 'HEAD' && write.op === 'put' && write.key === 'head:turn:active'), 'transcript read reaps')
  assert.equal((await fx.hs.storage.get('head:turn:active')).status, 'abandoned')
  // x6_wish status, against a fresh stale turn: POST /_head/transcript { action: 'wish_status', tab_id } (ball-loader.ts:7251-7275).
  const fx2 = await stack(t)
  const wish = await fx2.watch(() => fx2.send('POST', '/_head/transcript', { action: 'wish_status', tab_id: 'made-up-peer' }))
  assert.ok(wish.writes.some(write => write.object === 'HEAD' && write.op === 'put' && write.key === 'head:turn:active'), 'wish status reaps')
  assert.equal((await fx2.hs.storage.get('head:turn:active')).status, 'abandoned')
})
