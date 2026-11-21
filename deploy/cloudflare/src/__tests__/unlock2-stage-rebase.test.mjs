/** the repository reads commit 1: stage_proposal { allowRebase: true } brings main into her proposal branch with the host's own merge.
 * Fixed synthetic provider state (a fake GitHub with a commit graph and POST /merges); these tests never call GitHub. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { handleCloudBroker, REBASE_CONFLICT_NEXT, REBASE_CI_NOTE } from '../cloud-brokers.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'

const ORIGIN = 'https://fixture.example', PREFIX = '/repos/your_org_x/your-node'
const BRANCH = 'auma/proposal/fixture-fix', NOW = 1794367000000, EMAIL = 'owner@fixture.example'
const BOOTSTRAP = { ready: true, head: { phase: 'complete', seedId: '1'.repeat(64) }, mirror: { phase: 'ready' } }
const owner = { type: 'owner', email: EMAIL, expires: NOW / 1000 + 600 }
const json = (value, init) => Response.json(value, init)
const sha1 = value => createHash('sha1').update(value).digest('hex')
const digest = value => createHash('sha256').update(value).digest('hex')
const RELAY = 'deploy/cloudflare/src/crew-relay-tool.mjs'
const M0 = '0a'.repeat(20), M1 = '1b'.repeat(20), B1 = '2c'.repeat(20), MERGED = '3d'.repeat(20)

function treeOf(files, sha) {
  const entries = new Map()
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) entries.set(parts.slice(0, i).join('/'), { path: parts.slice(0, i).join('/'), mode: '040000', type: 'tree', sha: sha1(parts.slice(0, i).join('/') + sha) })
    entries.set(path, { path, mode: '100644', type: 'blob', sha: sha1(content), size: Buffer.byteLength(content) })
  }
  return { sha, truncated: false, tree: [...entries.values()] }
}

/**
 * main = M1 (one chore commit on M0), her branch = B1 (her change on M0): diverged, merge base M0.
 * `mainFiles` / `branchFiles` override each side; `mergeStatus` forces the host's merge answer.
 */
function fixture({ mainFiles, branchFiles, branchHead = B1, level, mergeStatus, access = owner } = {}) {
  const base = { [RELAY]: 'old\n', 'docs/auma/notes.md': 'a\n' }
  const commits = new Map([
    [M0, { parents: [], files: base }],
    [M1, { parents: [M0], files: mainFiles ?? { ...base, 'docs/auma/notes.md': 'a chore\n' } }],
    [B1, { parents: [M0], files: branchFiles ?? { ...base, [RELAY]: 'new\n' } }],
  ])
  const refs = new Map([['main', M1], [BRANCH, branchHead]]), calls = [], proposals = []
  const treeSha = sha => sha1('tree' + sha)
  const commitOfTree = new Map([...commits.keys()].map(sha => [treeSha(sha), sha]))
  const ancestors = sha => { const seen = new Set(), stack = [sha]; while (stack.length) { const next = stack.pop(); if (!seen.has(next)) { seen.add(next); stack.push(...commits.get(next).parents) } } return seen }
  const env = { GITHUB_TOKEN: 'synthetic-token-value', OWNER_EMAIL: EMAIL, PUBLIC_HOST: 'fixture.example', SOURCE_REVISION: M1 }
  env.HEAD = { idFromName: name => name, get: () => ({ fetch: async request => {
    const input = await request.json()
    if (input.action === 'stage') { proposals.push(input.proposal); return json({ ok: true }) }
    throw new Error('Unexpected HEAD action ' + input.action)
  } }) }
  const networkFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl); calls.push({ url: rawUrl, method: init.method, body: init.body })
    assert.equal(url.hostname, 'api.github.com'); assert.equal(init.redirect, 'error')
    if (url.pathname === PREFIX + '/merges') {
      assert.equal(init.method, 'POST')
      const body = JSON.parse(init.body)
      const ours = refs.get(body.base), theirs = body.head
      if (mergeStatus) return new Response(mergeStatus === 204 ? null : '{}', { status: mergeStatus })
      const b = commits.get(M0).files, o = commits.get(ours).files, t = commits.get(theirs).files, merged = {}
      for (const path of new Set([...Object.keys(o), ...Object.keys(t)])) {
        if (o[path] !== b[path] && t[path] !== b[path] && o[path] !== t[path]) return json({ message: 'Merge conflict' }, { status: 409 })
        const value = o[path] !== b[path] ? o[path] : t[path]
        if (value !== undefined) merged[path] = value
      }
      commits.set(MERGED, { parents: [ours, theirs], files: merged }); commitOfTree.set(treeSha(MERGED), MERGED)
      refs.set(body.base, MERGED)
      return json({ sha: MERGED, parents: [{ sha: ours }, { sha: theirs }] }, { status: 201 })
    }
    assert.equal(init.method, 'GET', 'only the merge endpoint writes')
    if (url.pathname.startsWith(PREFIX + '/git/ref/heads/')) {
      const branch = decodeURIComponent(url.pathname.slice((PREFIX + '/git/ref/heads/').length)), sha = refs.get(branch)
      return sha ? json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha } }) : new Response('', { status: 404 })
    }
    if (url.pathname.includes('/compare/')) {
      const [from, to] = url.pathname.split('/compare/')[1].split('...')
      const up = ancestors(to), down = ancestors(from)
      const status = from === to ? 'identical' : up.has(from) ? 'ahead' : down.has(to) ? 'behind' : 'diverged'
      const mergeBase = status === 'ahead' || status === 'identical' ? from : status === 'behind' ? to : M0
      return json({ base_commit: { sha: from }, merge_base_commit: { sha: mergeBase }, status, ahead_by: [...up].filter(sha => !down.has(sha)).length, behind_by: [...down].filter(sha => !up.has(sha)).length, files: [] })
    }
    if (url.pathname.endsWith('/runs') || url.pathname.endsWith('/actions/runs')) return json({ total_count: 0, workflow_runs: [] })
    if (url.pathname.startsWith(PREFIX + '/commits/')) {
      const ref = decodeURIComponent(url.pathname.slice((PREFIX + '/commits/').length)), sha = refs.get(ref) ?? ref
      return json({ sha, commit: { tree: { sha: treeSha(sha) } } })
    }
    if (url.pathname.startsWith(PREFIX + '/git/trees/')) {
      const tree = url.pathname.split('/').at(-1)
      return json(treeOf(commits.get(commitOfTree.get(tree)).files, tree))
    }
    if (url.pathname.startsWith(PREFIX + '/contents/')) {
      const path = decodeURIComponent(url.pathname.slice((PREFIX + '/contents/').length)), content = commits.get(url.searchParams.get('ref')).files[path]
      if (content === undefined) return new Response('', { status: 404 })
      return json({ type: 'file', path, sha: sha1(content), encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    throw new Error('Unexpected synthetic URL ' + url.pathname)
  }
  return { refs, calls, proposals,
    merges: () => calls.filter(call => call.url.endsWith('/merges')),
    async request(input) {
      const request = new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(input) })
      const response = await handleCloudBroker(request, env, { access, bootstrap: BOOTSTRAP, now: () => NOW, networkFetch, ...(level === 'guarded' ? { repoDoorLevel: 'guarded' } : {}) })
      return { status: response.status, value: await response.json() }
    },
  }
}

test('a branch one chore commit behind main: allowRebase merges main into HER branch and stages the new head', async () => {
  const broker = fixture()
  const result = await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: true, ownerSession: true })
  assert.equal(result.status, 200, JSON.stringify(result.value))
  const merges = broker.merges()
  assert.equal(merges.length, 1)
  assert.deepEqual(JSON.parse(merges[0].body), { base: BRANCH, head: M1, commit_message: `Merge main ${M1.slice(0, 12)} into ${BRANCH}` })
  assert.equal(broker.refs.get('main'), M1, 'main is never written')
  assert.equal(broker.refs.get(BRANCH), MERGED)
  const { proposal, rebase } = result.value
  assert.deepEqual(rebase, { merged: true, fromHeadSha: B1, headSha: MERGED, mainSha: M1, mergeBaseSha: M0, ciNote: REBASE_CI_NOTE })
  // The card binds the NEW head; its diff against main is her change only (main's chore came in with the merge).
  assert.deepEqual(proposal.mergeBody, { action: 'merge_proposal', baseSha: M1, branch: BRANCH, headSha: MERGED, treeSha: sha1('tree' + MERGED) })
  assert.equal(proposal.binding.bodySha256, digest(canonicalJson(proposal.mergeBody)))
  assert.deepEqual(proposal.changedFiles.map(file => file.path), [RELAY])
  assert.equal(proposal.ciStatus, 'none', 'no run on the new head yet: the card shows none until proposal-gate runs')
  assert.equal(broker.proposals.length, 1)
  // Staged again, the branch already carries main: nothing is merged a second time.
  const again = await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: true })
  assert.equal(again.status, 200); assert.equal(again.value.rebase.merged, false); assert.equal(broker.merges().length, 1)
})

test('a real conflict answers REBASE_CONFLICT naming the files, stages nothing and leaves her branch head unchanged', async () => {
  const base = { [RELAY]: 'old\n', 'docs/auma/notes.md': 'a\n' }
  const broker = fixture({ mainFiles: { ...base, [RELAY]: 'main side\n', 'docs/auma/notes.md': 'both\n' }, branchFiles: { ...base, [RELAY]: 'her side\n', 'docs/auma/notes.md': 'both\n' } })
  const result = await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: true })
  assert.equal(result.status, 409, JSON.stringify(result.value))
  assert.equal(result.value.code, 'REBASE_CONFLICT')
  // Only the file changed differently on both sides; notes.md changed identically on both and is no conflict.
  assert.deepEqual(result.value.conflicts, [RELAY])
  assert.equal(result.value.conflictsComputed, true); assert.equal(result.value.conflictsNamedByHost, false)
  assert.equal(result.value.staged, false); assert.equal(result.value.branchUnchanged, true)
  assert.equal(result.value.headSha, B1); assert.equal(result.value.mainSha, M1); assert.equal(result.value.next, REBASE_CONFLICT_NEXT)
  assert.equal(result.value.outcome, undefined, 'a conflict is a known outcome, never REPO_REF_OUTCOME_UNKNOWN')
  assert.equal(broker.refs.get(BRANCH), B1); assert.equal(broker.refs.get('main'), M1); assert.equal(broker.proposals.length, 0)
})

test('without allowRebase a branch behind main answers REPO_MAIN_ANCESTRY_REQUIRED as today, with no write', async () => {
  for (const input of [{ action: 'stage_proposal', branch: BRANCH, title: 'Fix' }, { action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: false }]) {
    const broker = fixture()
    const result = await broker.request(input)
    assert.equal(result.status, 403); assert.equal(result.value.code, 'REPO_MAIN_ANCESTRY_REQUIRED')
    assert.equal(result.value.rebase, undefined)
    assert.equal(broker.merges().length, 0); assert.equal(broker.refs.get(BRANCH), B1); assert.equal(broker.proposals.length, 0)
  }
})

test('allowRebase must be a boolean; a branch not hers and main itself are refused before any network call', async () => {
  const broker = fixture()
  for (const allowRebase of ['true', 1, null]) {
    const result = await broker.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase })
    assert.equal(result.value.code, 'BROKER_QUERY_INVALID')
  }
  for (const branch of ['main', 'auma/sandbox/fixture-fix', 'feature/fixture', 'auma/proposal/a..b']) {
    const result = await broker.request({ action: 'stage_proposal', branch, title: 'Fix', allowRebase: true })
    assert.equal(result.status, 403); assert.equal(result.value.code, 'REPO_BRANCH_REFUSED')
  }
  assert.equal(broker.calls.length, 0)
  for (const access of [null, { ...owner, email: 'other@fixture.example' }]) {
    const stranger = fixture({ access })
    assert.equal((await stranger.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: true })).value.code, 'OWNER_SESSION_REQUIRED')
    assert.equal(stranger.calls.length, 0)
  }
})

test('a refused path on her branch is judged before the merge: nothing is merged, written or staged', async () => {
  const base = { [RELAY]: 'old\n', 'docs/auma/notes.md': 'a\n' }
  const open = fixture({ branchFiles: { ...base, 'server/.env': 'X=1\n' } })
  const credential = await open.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: true })
  assert.equal(credential.status, 403, JSON.stringify(credential.value))
  assert.equal(open.merges().length, 0); assert.equal(open.refs.get(BRANCH), B1); assert.equal(open.proposals.length, 0)
  const guarded = fixture({ level: 'guarded', branchFiles: { ...base, '.github/workflows/hidden.yml': 'on: push\n' } })
  const workflow = await guarded.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: true })
  assert.equal(workflow.status, 403); assert.equal(workflow.value.code, 'REPO_PROPOSAL_PATH_REFUSED')
  assert.equal(guarded.merges().length, 0); assert.equal(guarded.refs.get(BRANCH), B1); assert.equal(guarded.proposals.length, 0)
})

test('the host answers: 204 is nothing to merge, another refusal writes nothing, a 5xx is an unknown outcome', async () => {
  const nothing = fixture({ mergeStatus: 204 })
  const none = await nothing.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: true })
  assert.equal(none.value.code, 'REPO_MAIN_ANCESTRY_REQUIRED', 'nothing merged: the card is judged exactly as without the option')
  const refused = fixture({ mergeStatus: 403 })
  const answer = await refused.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: true })
  assert.equal(answer.value.code, 'BROKER_UPSTREAM_FAILED'); assert.equal(answer.value.outcome, undefined); assert.equal(refused.proposals.length, 0)
  const lost = fixture({ mergeStatus: 502 })
  const unknown = await lost.request({ action: 'stage_proposal', branch: BRANCH, title: 'Fix', allowRebase: true })
  assert.equal(unknown.value.code, 'REPO_REF_OUTCOME_UNKNOWN'); assert.equal(unknown.value.outcome, 'unknown'); assert.equal(lost.proposals.length, 0)
})
