/** A staged repo proposal could leave HEAD only by a merge or a
 * reconcile, so a card whose commit was already on main (its branch deleted) stayed as a dead "a merge is waiting for your
 * fingerprint" row nothing could remove. `withdraw_proposal { branch, headSha }` takes it back: owner session, no
 * passkey, nothing spent, nothing merged; refused while an attempt is pending or held (their own paths stay). Real HEAD
 * durable object, synthetic GitHub, no network. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker } from '../cloud-brokers.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, manifestIdCanon } from '../head-do.mjs'
import { READER_WINDOW_COOKIE } from '../reader-window.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40), BASE_TREE = 'd'.repeat(40), HEAD_TREE = 'e'.repeat(40)
const BRANCH = 'auma/proposal/fixture-window', EMAIL = 'owner@fixture.example', FREE = 'deploy/cloudflare/src/crew-relay-tool.mjs'
const ATTEMPT = 'head:repo-merge-attempt', ATTEMPT_OWNER = 'head:repo-merge-attempt-owner', OUTCOME = 'head:last-repo-merge-outcome', STAGE = 'head:staged-repo-proposal'
const GATE_JOBS = ['preflight', 'build', 'scrub-dist', 'bundle']
const digest = value => createHash('sha256').update(value).digest('hex')
const blob = value => createHash('sha1').update(value).digest('hex')
const json = value => Response.json(value)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const refusal = (code, status = 403) => Object.assign(new Error(code), { code, status })
const withdraw = (headSha = HEAD) => ({ action: 'withdraw_proposal', branch: BRANCH, headSha })

function tree(files, sha) {
  const entries = new Map()
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) { const parent = parts.slice(0, i).join('/'); entries.set(parent, { path: parent, mode: '040000', type: 'tree', sha: blob(parent + sha) }) }
    entries.set(path, { path, mode: '100644', type: 'blob', sha: blob(content), size: Buffer.byteLength(content) })
  }
  return { sha, truncated: false, tree: [...entries.values()] }
}

async function realHead() {
  let data = new Map(), tail = Promise.resolve()
  const view = map => ({ get: async key => structuredClone(map.get(key)), put: async (key, value) => { map.set(key, structuredClone(value)) }, delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.transaction = operation => { const task = tail.then(async () => { const next = structuredClone(data), result = await operation(view(next)); data = next; return result }); tail = task.catch(() => {}); return task }
  const env = { PUBLIC_HOST: 'fixture.example', OWNER_EMAIL: EMAIL, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  const events = []
  head.broadcast = async value => { events.push(value) }
  const code = 'export const organ = "fixture";\n', sha = digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 167, parentBallId: null, createdAt: '2026-11-11T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } }, modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(code) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }, payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } }, seedId = digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: ball.ballId, epoch: 167, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  return { head, seedId, env, storage, events }
}

/** The broker over the real HEAD. `slow(url)` delays each GitHub answer; `ci` sets each workflow's conclusion;
 * `around(action, forward)` wraps each HEAD call; `begunAt` is when begin_merge left for HEAD. */
async function harness({ files = null } = {}) {
  const { head, seedId, env: headEnv, storage, events } = await realHead()
  const refs = new Map([['main', BASE], [BRANCH, HEAD]]), calls = [], actions = [], tokens = new Map()
  const state = { slow: () => 0, graphql: null, consumed: 0, around: null, begunAt: null, repoFails: false, ci: { 'proposal-gate.yml': 'success', 'proposal-checks.yml': 'success' }, checksMalformed: false }
  const access = { type: 'owner', email: EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }
  const before = files?.before ?? { [FREE]: 'old\n' }, after = files?.after ?? { [FREE]: 'new\n' }
  head.aumlokStore = { consumeApprovalInTransaction: async (tx, token, binding, origin) => {
    const approval = tokens.get(token)
    if (!approval || canonicalJson(approval.binding) !== canonicalJson(binding) || origin !== ORIGIN || typeof tx?.put !== 'function') throw refusal('CLASS3_WEBAUTHN_REQUIRED')
    if (approval.expiresAt <= Date.now()) throw refusal('CLASS3_APPROVAL_EXPIRED')
    tokens.delete(token); state.consumed++
    return { ok: true, binding: approval.binding, approvalId: null, expiresAt: approval.expiresAt }
  } }
  const headBinding = { idFromName: name => name, get: () => ({ fetch: async request => {
    const { action } = request.method === 'POST' ? await request.clone().json() : { action: 'GET ' + new URL(request.url).pathname }
    if (request.method === 'POST') actions.push(action)
    if (action === 'begin_merge') state.begunAt = Date.now()
    const forward = () => head.fetch(request)
    return state.around ? await state.around(action, forward) : await forward()
  } }) }
  const env = { ...headEnv, GITHUB_TOKEN: 'synthetic-token-value', SOURCE_REVISION: BASE, HEAD: headBinding }
  const run = (workflow, id) => ({ id, workflow_id: id, run_number: 3, run_attempt: 1, head_sha: HEAD, head_branch: BRANCH, event: 'push', path: `.github/workflows/${workflow}`, status: 'completed', conclusion: state.ci[workflow] })
  const job = (name, runId, id) => ({ id, run_id: runId, head_sha: HEAD, name, status: 'completed', conclusion: 'success' })
  const networkFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl); calls.push({ url: rawUrl, path: url.pathname, method: init.method, at: Date.now(), after: actions.length, signal: init.signal })
    assert.equal(url.hostname, 'api.github.com')
    const delay = state.slow(url)
    if (delay) await sleep(delay)
    if (state.hook) { const answer = await state.hook(url, init); if (answer) return answer }
    if (url.pathname.endsWith('/actions/workflows/proposal-gate.yml/runs')) return json({ total_count: 1, workflow_runs: [run('proposal-gate.yml', 7)] })
    if (url.pathname.endsWith('/actions/workflows/proposal-checks.yml/runs')) return json(state.checksMalformed ? { total_count: 1, workflow_runs: [{ id: 8 }] } : { total_count: 1, workflow_runs: [run('proposal-checks.yml', 8)] })
    if (url.pathname.endsWith('/actions/runs/7/attempts/1/jobs')) return json({ total_count: 4, jobs: GATE_JOBS.map((name, index) => job(name, 7, 100 + index)) })
    if (url.pathname.endsWith('/actions/runs/8/attempts/1/jobs')) return json({ total_count: 1, jobs: [job('checks', 8, 200)] })
    if (url.pathname === '/graphql') {
      const input = JSON.parse(init.body).variables.input
      if (state.graphql) { const answer = await state.graphql(input, refs); if (answer) return answer }
      if (input.refUpdates.some(update => (refs.get(update.name.slice('refs/heads/'.length)) ?? '0'.repeat(40)) !== update.beforeOid)) return json({ data: { updateRefs: null }, errors: [{ type: 'STALE_DATA' }] })
      for (const update of input.refUpdates) refs.set(update.name.slice('refs/heads/'.length), update.afterOid)
      return json({ data: { updateRefs: { clientMutationId: input.clientMutationId } } })
    }
    if (url.pathname === PREFIX) return state.repoFails ? new Response('', { status: 500 }) : json({ full_name: 'your_org_x/your-node', default_branch: 'main', node_id: 'R_fixture' })
    if (url.pathname.startsWith(PREFIX + '/git/ref/heads/')) {
      const branch = decodeURIComponent(url.pathname.slice((PREFIX + '/git/ref/heads/').length)), sha = refs.get(branch)
      return sha ? json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha } }) : new Response('', { status: 404 })
    }
    if (url.pathname === PREFIX + '/commits' && url.search === '?sha=main&per_page=1') return json([{ sha: refs.get('main'), commit: { message: 'Base' }, parents: [] }])
    if (url.pathname.includes('/compare/')) {
      const [base, tip] = url.pathname.split('/compare/')[1].split('...')
      return json({ base_commit: { sha: base }, merge_base_commit: { sha: base }, ahead_by: base === tip ? 0 : 1, behind_by: 0, status: base === tip ? 'identical' : 'ahead', files: [] })
    }
    if (url.pathname.startsWith(PREFIX + '/commits/')) {
      const ref = decodeURIComponent(url.pathname.slice((PREFIX + '/commits/').length)), sha = refs.get(ref) ?? ref
      return json({ sha, commit: { tree: { sha: sha === BASE ? BASE_TREE : HEAD_TREE } } })
    }
    if (url.pathname.startsWith(PREFIX + '/git/trees/')) { const sha = url.pathname.split('/').at(-1); return json(tree(sha === BASE_TREE ? before : after, sha)) }
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      if (state.contentsFail) return new Response('', { status: 500 })
      const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), content = (url.searchParams.get('ref') === BASE ? before : after)[path]
      if (content === undefined) return new Response('', { status: 404 })
      return json({ type: 'file', path, sha: blob(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  const request = async (input, { token, signal, cookie } = {}) => {
    const current = new Request(ORIGIN + '/_host/repo', { method: 'POST', ...(signal ? { signal } : {}), headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(token ? { 'x-x6-class3-approval': token } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(input) })
    const response = await handleCloudBroker(current, env, { access, bootstrap: { ready: true, head: { phase: 'complete', seedId }, mirror: { phase: 'ready' } }, now: () => Date.now(), networkFetch,
      authorizeClass3: async () => ({ ok: false }) })
    return { status: response.status, value: await response.json() }
  }
  const status = async () => await (await head.fetch(new Request('https://x61.internal/_head/promotion-status', { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, 'x-x6-verified-access': JSON.stringify(access) } }))).json()
  let issued = 0
  const grant = input => {
    const token = 'fixture-approval-' + ++issued
    tokens.set(token, { expiresAt: Date.now() + 120000, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/repo', bodySha256: digest(canonicalJson(input)) } })
    return token
  }
  const staged = await request({ action: 'stage_proposal', branch: BRANCH, title: 'Read window fixture' })
  assert.equal(staged.status, 200, JSON.stringify(staged.value))
  calls.length = 0; actions.length = 0
  const posts = () => calls.filter(call => call.method === 'POST').length
  /** Nothing of his was spent and HEAD holds nothing: read from HEAD's own storage and the approval store. */
  const unspent = async token => {
    assert.equal(state.consumed, 0, 'no approval consumed'); assert.equal(tokens.has(token), true, 'his approval is still there')
    assert.equal(await storage.get(ATTEMPT), undefined, 'HEAD holds no attempt'); assert.equal(await storage.get(ATTEMPT_OWNER), undefined)
    assert.equal(await storage.get(OUTCOME), undefined, 'no outcome written'); assert.equal(actions.includes('begin_merge'), false)
    assert.equal(posts(), 0, 'nothing sent'); assert.equal(refs.get('main'), BASE, 'main did not move')
  }
  return { state, refs, calls, actions, tokens, request, status, grant, posts, storage, access, before, after, unspent, events, env, mergeBody: staged.value.proposal.mergeBody }
}


/** HEAD still holds the card, untouched. */
async function kept(fx) {
  const stage = await fx.storage.get(STAGE)
  assert.equal(stage?.branch, BRANCH); assert.equal(stage.mergeBody.headSha, HEAD)
  assert.equal(fx.events.some(event => event.withdrawn === true), false, 'no withdrawn event')
}

test('a staged card with no attempt is taken back: HEAD\'s stage gone, promotion-status shows none, the repo:staged event sent; nothing spent or sent', async () => {
  const fx = await harness()
  assert.notEqual((await fx.status()).stagedRepoProposal, null)
  fx.events.length = 0
  const result = await fx.request(withdraw())
  assert.equal(result.status, 200, JSON.stringify(result.value))
  assert.deepEqual(result.value, { ok: true, action: 'withdraw_proposal', withdrawn: true, branch: BRANCH, headSha: HEAD })
  assert.equal(await fx.storage.get(STAGE), undefined)
  assert.equal((await fx.status()).stagedRepoProposal, null)
  assert.deepEqual(fx.events, [{ type: 'repo:staged', withdrawn: true, branch: BRANCH, headSha: HEAD }])
  assert.equal(fx.calls.length, 0, 'no GitHub request at all'); assert.equal(fx.state.consumed, 0)
  assert.equal(await fx.storage.get(ATTEMPT), undefined); assert.equal(await fx.storage.get(OUTCOME), undefined)
  // Nothing staged now: said so, nothing changes.
  const again = await fx.request(withdraw())
  assert.equal(again.status, 200, JSON.stringify(again.value))
  assert.deepEqual(again.value, { ok: true, action: 'withdraw_proposal', withdrawn: false, code: 'REPO_PROPOSAL_NOT_STAGED' })
  assert.equal(fx.events.length, 1, 'no event for nothing')
})

test('the withdrawn card\'s approval can no longer merge: refused, unspent, main unmoved', async () => {
  const fx = await harness(), token = fx.grant(fx.mergeBody)
  assert.equal((await fx.request(withdraw())).value.withdrawn, true)
  const merge = await fx.request(fx.mergeBody, { token })
  assert.equal(merge.status, 409, JSON.stringify(merge.value)); assert.equal(merge.value.code, 'REPO_PROPOSAL_MISSING')
  assert.equal(fx.tokens.has(token), true); assert.equal(fx.state.consumed, 0); assert.equal(fx.posts(), 0); assert.equal(fx.refs.get('main'), BASE)
  assert.equal(await fx.storage.get(ATTEMPT), undefined)
})

test('an attempt pending (claimed, its call still running) or held (dispatched, outcome unknown) refuses with today\'s code; nothing deleted', async () => {
  // Pending: the first merge is held just after HEAD claimed the attempt.
  const fx = await harness()
  let release, reached
  const held = new Promise(resolve => { release = resolve }), arrived = new Promise(resolve => { reached = resolve })
  fx.state.around = async (action, forward) => { const response = await forward(); if (action === 'begin_merge') { reached(); await held } return response }
  const first = fx.request(fx.mergeBody, { token: fx.grant(fx.mergeBody) })
  await arrived
  const pending = await fx.request(withdraw())
  assert.equal(pending.status, 409, JSON.stringify(pending.value)); assert.equal(pending.value.code, 'REPO_MERGE_PENDING'); assert.equal(pending.value.outcome, 'unknown')
  await kept(fx)
  release(); assert.equal((await first).status, 200)
  // Held: the ref update's answer was lost; the attempt stays dispatched until reconciled or released.
  const gx = await harness()
  gx.state.graphql = async () => json({ data: null, errors: [{ type: 'INTERNAL' }] })
  assert.equal((await gx.request(gx.mergeBody, { token: gx.grant(gx.mergeBody) })).value.code, 'REPO_REF_OUTCOME_UNKNOWN')
  assert.equal((await gx.status()).repoMergeAttempt.state, 'dispatched')
  const heldAnswer = await gx.request(withdraw())
  assert.equal(heldAnswer.status, 409, JSON.stringify(heldAnswer.value)); assert.equal(heldAnswer.value.code, 'REPO_MERGE_PENDING')
  await kept(gx); assert.equal((await gx.status()).repoMergeAttempt.state, 'dispatched')
})

test('another head (the card was re-staged), no owner session, a reader window, bad terms: refused, the card stays', async () => {
  const fx = await harness()
  const changed = await fx.request(withdraw(NEXT))
  assert.equal(changed.status, 409, JSON.stringify(changed.value)); assert.equal(changed.value.code, 'REPO_PROPOSAL_CHANGED')
  await kept(fx)
  const owner = fx.access.email
  fx.access.email = 'stranger@fixture.example'
  const stranger = await fx.request(withdraw())
  fx.access.email = owner
  assert.equal(stranger.status, 403, JSON.stringify(stranger.value)); assert.equal(stranger.value.code, 'OWNER_SESSION_REQUIRED')
  const expires = fx.access.expires
  fx.access.expires = Math.floor(Date.now() / 1000) - 1
  const expired = await fx.request(withdraw())
  fx.access.expires = expires
  assert.equal(expired.value.code, 'OWNER_SESSION_REQUIRED', JSON.stringify(expired.value))
  fx.env.THREAD_SYNC = 'on'
  const reader = await fx.request(withdraw(), { cookie: `${READER_WINDOW_COOKIE}=reader` })
  delete fx.env.THREAD_SYNC
  assert.equal(reader.status, 403, JSON.stringify(reader.value)); assert.equal(reader.value.code, 'READER_WINDOW')
  for (const body of [{ ...withdraw(), extra: 1 }, { action: 'withdraw_proposal', branch: 'auma/sandbox/fixture-window', headSha: HEAD }, { action: 'withdraw_proposal', branch: BRANCH }, { ...withdraw(), ownerSession: 'yes' }]) {
    const bad = await fx.request(body)
    assert.equal(bad.value.ok, false, JSON.stringify(body)); assert.notEqual(bad.status, 200)
  }
  await kept(fx); assert.equal(fx.calls.length, 0)
  // His own page sends ownerSession: true (as for stage_proposal): accepted.
  const own = await fx.request({ ...withdraw(), ownerSession: true })
  assert.equal(own.value.withdrawn, true, JSON.stringify(own.value))
})
