/** Her Linear door (linear-door.mjs). A fake Linear records every request; nothing here reaches Linear. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { createLinearDoor, LINEAR_ACTIONS, LINEAR_CORE, LINEAR_DOOR_LIMITS, LINEAR_NEXT, LINEAR_OPEN_WRITES, LINEAR_READS, linearDoorLevel, linearScreenClean } from '../linear-door.mjs'

const ORIGIN = 'https://node.example.invalid'
// Made up for these tests; the screen must catch it even though it has no known key format.
const KEY = 'made-up-linear-key-0123456789-not-real'
const ENV = Object.freeze({ LINEAR_API_KEY: KEY, OWNER_EMAIL: 'owner@example.test', LINEAR_DOOR_LEVEL: 'open' })
const NOW = 1_800_000_000_000
const ACCESS = Object.freeze({ type: 'owner', email: 'owner@example.test', expires: NOW / 1000 + 86400, session: 'made-up-session-mac-1' })
const UUID1 = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const RID = 'request-0001-abcdef'
const PAGE = { hasNextPage: false, endCursor: 'cursor-1' }

/** Everything a test may see leave the door: answers, console lines, thrown errors. The key must be in none of them. */
const seen = []
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level]
  console[level] = (...args) => { seen.push(args.map(String).join(' ')); return original.apply(console, args) }
}

function fakeLinear(answer = () => ({ data: {} }), { status = 200, delayForever = false } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, authorization: init.headers.authorization, redirect: init.redirect, raw: init.body, query: body.query, variables: body.variables })
    if (delayForever) return await new Promise(() => {})
    const value = answer(body.query, body.variables, calls.length)
    if (value instanceof Response) return value
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImpl }
}

function post(body, { headers = {}, raw } = {}) {
  return new Request(ORIGIN + '/_host/linear', {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(body),
  })
}

async function call(door, body, { env = ENV, access = ACCESS, authorizeClass3 = null, request } = {}) {
  try {
    const response = await door(request ?? post(body), env, { access, authorizeClass3 })
    const text = await response.text()
    seen.push(text)
    return { status: response.status, body: JSON.parse(text), text }
  } catch (error) {
    seen.push(String(error), String(error?.stack))
    throw error
  }
}

const door = (fake, more = {}) => createLinearDoor({ fetchImpl: fake.fetchImpl, now: () => NOW, ...more })

/** The approval HEAD gives for exactly this body (aumlok.mjs aumlokClass3Binding), as edgeClass3 would. */
async function approvalFor(body, { expiresAt = NOW + 60_000, tamper = false } = {}) {
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(body))))].map(b => b.toString(16).padStart(2, '0')).join('')
  return { ok: true, expiresAt, binding: { schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: '/_host/linear', bodySha256: tamper ? 'f'.repeat(64) : digest } }
}

// ---- reads -----------------------------------------------------------------------------------------------------------
const ISSUE_NODE = { id: UUID1, identifier: 'YOURTEAM-398', title: 'CREW RELAY' }
const READS = [
  ['status', {}, data => ({ viewer: { id: 'u1', name: 'The owner', displayName: 'owner' }, organization: { name: 'Example Org', urlKey: 'example-org' } }), {}],
  ['teams', { first: 10 }, () => ({ teams: { nodes: [{ id: UUID1, key: 'YOURTEAM', name: 'Example Org' }], pageInfo: PAGE } }), { first: 10, after: null }],
  ['projects', { after: 'abc' }, () => ({ projects: { nodes: [], pageInfo: PAGE } }), { first: 50, after: 'abc' }],
  ['issue', { id: 'YOURTEAM-398' }, () => ({ issue: ISSUE_NODE }), { id: 'YOURTEAM-398' }],
  ['issues', { team: 'YOURTEAM', project: UUID2, state: 'In Progress', assignee: 'me', updatedSince: '2026-11-13T07:00:00.000Z', first: 5 },
    () => ({ issues: { nodes: [ISSUE_NODE], pageInfo: PAGE } }),
    { filter: { team: { key: { eq: 'YOURTEAM' } }, project: { id: { eq: UUID2 } }, state: { name: { eq: 'In Progress' } }, assignee: { isMe: { eq: true } }, updatedAt: { gte: '2026-11-13T07:00:00.000Z' } }, first: 5, after: null }],
  ['search', { text: 'voice' }, () => ({ issues: { nodes: [], pageInfo: PAGE } }),
    { filter: { or: [{ title: { containsIgnoreCase: 'voice' } }, { description: { containsIgnoreCase: 'voice' } }] }, first: 50, after: null }],
  ['comments', { issue: 'YOURTEAM-398' }, () => ({ issue: { id: UUID1, identifier: 'YOURTEAM-398', comments: { nodes: [{ id: 'c1', body: 'hi' }], pageInfo: PAGE } } }), { id: 'YOURTEAM-398', first: 50, after: null }],
  ['comments', { project: UUID2, first: 3 }, () => ({ project: { id: UUID2, name: 'P', comments: { nodes: [], pageInfo: PAGE } } }), { id: UUID2, first: 3, after: null }],
  ['comments', { document: UUID2 }, () => ({ document: { id: UUID2, title: 'D', comments: { nodes: [], pageInfo: PAGE } } }), { id: UUID2, first: 50, after: null }],
  ['documents', { project: UUID2 }, () => ({ documents: { nodes: [], pageInfo: PAGE } }), { filter: { project: { id: { eq: UUID2 } } }, first: 50, after: null }],
  ['document', { id: UUID2 }, () => ({ document: { id: UUID2, title: 'Plan', content: 'x' } }), { id: UUID2 }],
  ['labels', { team: UUID1 }, () => ({ issueLabels: { nodes: [], pageInfo: PAGE } }), { filter: { team: { id: { eq: UUID1 } } }, first: 50, after: null }],
  ['states', {}, () => ({ workflowStates: { nodes: [], pageInfo: PAGE } }), { filter: null, first: 50, after: null }],
  ['users', {}, () => ({ users: { nodes: [{ id: 'u1', name: 'The owner' }], pageInfo: PAGE } }), { first: 50, after: null }],
]

test('the action table is the whole truth: twelve reads, eight open writes, the core, and nothing raw', () => {
  assert.deepEqual([...LINEAR_READS], ['status', 'teams', 'projects', 'issue', 'issues', 'search', 'comments', 'documents', 'document', 'labels', 'states', 'users'])
  assert.deepEqual([...LINEAR_OPEN_WRITES], ['comment', 'comment_update', 'issue_create', 'issue_update', 'document_create', 'document_update', 'project_update_post', 'label_create'])
  assert.deepEqual([...LINEAR_CORE], ['issue_archive', 'issue_delete', 'document_delete', 'project_archive', 'project_delete', 'team_delete', 'project_settings',
    'team_settings', 'team_member_add', 'team_member_remove'])
  for (const [name, spec] of Object.entries(LINEAR_ACTIONS)) {
    const texts = typeof spec.query === 'function' ? [{ issue: 'x' }, { project: 'x' }, { document: 'x' }].map(spec.query) : [spec.query]
    for (const text of texts) {
      assert.match(text, spec.kind === 'read' ? /^query LinearDoor[A-Za-z]+[ (]/ : /^mutation LinearDoor[A-Za-z]+\(/, name)
      // Every value she gives goes as a variable: no query text is ever built from her words.
      assert.ok(!text.includes('${'), name)
    }
  }
})

test('every read sends its one exact query with exact variables, and answers bounded and paged', async () => {
  for (const [name, input, data, variables] of READS) {
    const fake = fakeLinear(() => ({ data: data() }))
    const answer = await call(door(fake), { action: name, ...input })
    assert.equal(answer.status, 200, `${name}: ${answer.text}`)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.action, name)
    assert.equal(fake.calls.length, 1, name)
    const spec = LINEAR_ACTIONS[name]
    assert.equal(fake.calls[0].query, typeof spec.query === 'function' ? spec.query(input) : spec.query, name)
    assert.ok(!/\bmutation\b/.test(fake.calls[0].query), `${name} reads only`)
    assert.deepEqual(fake.calls[0].variables, variables, name)
    assert.equal(fake.calls[0].url, 'https://api.linear.app/graphql')
    assert.equal(fake.calls[0].redirect, 'manual')
    assert.equal(fake.calls[0].authorization, KEY)
    assert.ok(!fake.calls[0].raw.includes(KEY), 'the key goes in the header, never the body')
    if (name === 'status') assert.deepEqual({ ...answer.body, asks: undefined }, { ok: true, action: 'status', level: 'open', configured: true,
      workspace: 'Example Org', urlKey: 'example-org', viewer: 'owner', viewerId: 'u1', asks: undefined, asksAtGuarded: 'every write' })
    else if (!['issue', 'document'].includes(name)) assert.deepEqual(answer.body.page, PAGE, name)
  }
})

test('a read of an id Linear does not know is LINEAR_NOT_FOUND, with none of Linear\'s words', async () => {
  for (const answer of [{ data: { issue: null } }, { errors: [{ message: 'Entity not found: Issue - made-up provider words' }] }]) {
    const fake = fakeLinear(() => answer)
    const result = await call(door(fake), { action: 'issue', id: 'OTHER-1' })
    assert.deepEqual([result.status, result.body], [404, { ok: false, code: 'LINEAR_NOT_FOUND' }])
  }
})

test('an answer over 256 KiB is refused whole: LINEAR_ANSWER_TOO_LARGE with what to do', async () => {
  const big = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, title: 'x'.repeat(6000) }))
  const fake = fakeLinear(() => ({ data: { issues: { nodes: big, pageInfo: PAGE } } }))
  const result = await call(door(fake), { action: 'issues' })
  assert.equal(result.status, 413)
  assert.equal(result.body.code, 'LINEAR_ANSWER_TOO_LARGE')
  assert.ok(result.text.length < 1024)
  assert.equal(LINEAR_DOOR_LIMITS.answerBytes, 256 * 1024)
})

// ---- writes ----------------------------------------------------------------------------------------------------------
const OPEN_WRITES = [
  ['comment', { issue: UUID1, body: 'Hello from Auma.' }, 'commentCreate', [{ input: { issueId: UUID1, body: 'Hello from Auma.' } }]],
  ['comment', { issue: 'YOURTEAM-398', body: 'Reply.', parent: 'c1' }, 'commentCreate', [{ id: 'YOURTEAM-398' }, { input: { issueId: UUID1, body: 'Reply.', parentId: 'c1' } }]],
  ['comment_update', { id: 'c1', body: 'Edited.' }, 'commentUpdate', [{ id: 'c1' }, { id: 'c1', input: { body: 'Edited.' } }]],
  ['issue_create', { teamId: UUID1, title: 'New', description: 'd', priority: 2, labelIds: [UUID2], dueDate: '2026-12-01' }, 'issueCreate',
    [{ input: { teamId: UUID1, title: 'New', description: 'd', priority: 2, labelIds: [UUID2], dueDate: '2026-12-01' } }]],
  ['issue_update', { id: 'YOURTEAM-398', stateId: UUID2, assigneeId: null, dueDate: null }, 'issueUpdate', [{ id: 'YOURTEAM-398' }, { id: UUID1, input: { stateId: UUID2, assigneeId: null, dueDate: null } }]],
  ['document_create', { title: 'Plan', content: '# Plan', projectId: UUID2 }, 'documentCreate', [{ input: { title: 'Plan', content: '# Plan', projectId: UUID2 } }]],
  ['document_update', { id: UUID2, content: 'v2' }, 'documentUpdate', [{ id: UUID2, input: { content: 'v2' } }]],
  ['project_update_post', { projectId: UUID2, body: 'On track.', health: 'onTrack' }, 'projectUpdateCreate', [{ input: { projectId: UUID2, body: 'On track.', health: 'onTrack' } }]],
  ['label_create', { name: 'voice', color: '#aabbcc' }, 'issueLabelCreate', [{ input: { name: 'voice', color: '#aabbcc' } }]],
]
function writeAnswers(root) {
  return (query) => {
    if (/^query LinearDoorIssueId/.test(query)) return { data: { issue: { id: UUID1 } } }
    if (/^query LinearDoorCommentOwner/.test(query)) return { data: { viewer: { id: 'u-auma' }, comment: { id: 'c1', user: { id: 'u-auma' } } } }
    return { data: { [root]: { success: true, result: 'made-up' } } }
  }
}

test('every open write sends its exact mutation once with the exact variables; an identifier is looked up first', async () => {
  let n = 0
  for (const [name, fields, root, variables] of OPEN_WRITES) {
    const fake = fakeLinear(writeAnswers(root))
    const body = { action: name, requestId: `request-open-${String(n += 1).padStart(4, '0')}`, ...fields }
    const answer = await call(door(fake), body)
    assert.equal(answer.status, 200, `${name}: ${answer.text}`)
    assert.deepEqual(answer.body, { ok: true, action: name, level: 'open', requestId: body.requestId, result: { result: 'made-up' } })
    assert.deepEqual(fake.calls.map(c => c.variables), variables, name)
    assert.equal(fake.calls.filter(c => /^mutation/.test(c.query)).length, 1, name)
    assert.equal(fake.calls.at(-1).query, LINEAR_ACTIONS[name].query, name)
  }
})

test('comment_update edits her own comment only: someone else\'s is refused and nothing is written', async () => {
  const fake = fakeLinear(() => ({ data: { viewer: { id: 'u-auma' }, comment: { id: 'c9', user: { id: 'u-owner' } } } }))
  const result = await call(door(fake), { action: 'comment_update', requestId: RID, id: 'c9', body: 'mine now' })
  assert.deepEqual([result.status, result.body], [403, { ok: false, code: 'LINEAR_NOT_HER_COMMENT' }])
  assert.equal(fake.calls.filter(c => /^mutation/.test(c.query)).length, 0)
})

test('a write that Linear answers without success is LINEAR_WRITE_REFUSED', async () => {
  const fake = fakeLinear(() => ({ data: { issueLabelCreate: { success: false } } }))
  const result = await call(door(fake), { action: 'label_create', requestId: RID, name: 'x' })
  assert.deepEqual([result.status, result.body], [502, { ok: false, code: 'LINEAR_WRITE_REFUSED' }])
})

// ---- the dangerous core ----------------------------------------------------------------------------------------------
const CORE = [
  ['issue_archive', { id: 'YOURTEAM-398' }, 'issueArchive', 'archive'],
  ['issue_delete', { id: UUID1 }, 'issueDelete', 'delete'],
  ['document_delete', { id: UUID2 }, 'documentDelete', 'delete'],
  ['project_archive', { id: UUID2 }, 'projectArchive', 'archive'],
  ['project_delete', { id: UUID2 }, 'projectDelete', 'delete'],
  ['team_delete', { id: UUID1 }, 'teamDelete', 'delete'],
  ['project_settings', { id: UUID2, memberIds: [UUID1] }, 'projectUpdate', 'project-settings'],
  ['team_settings', { id: UUID1, private: true }, 'teamUpdate', 'team-settings'],
  ['team_member_add', { teamId: UUID1, userId: UUID2 }, 'teamMembershipCreate', 'team-membership'],
  ['team_member_remove', { id: UUID2 }, 'teamMembershipDelete', 'team-membership'],
  ['issue_update', { id: UUID1, teamId: UUID2 }, 'issueUpdate', 'team-move'],
]

test('the core asks at both levels and sends nothing until approved; then exactly once, with the approved bytes', async () => {
  for (const level of ['open', 'guarded']) {
    let n = 0
    for (const [name, fields, root, reason] of CORE) {
      const env = { ...ENV, LINEAR_DOOR_LEVEL: level }
      const fake = fakeLinear(writeAnswers(root))
      const linear = door(fake)
      const body = { action: name, requestId: `request-core-${level}-${String(n += 1).padStart(3, '0')}`, ...fields }
      const held = { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', reason: level === 'open' || reason !== null ? reason : 'guarded-level', level,
        next: 'nothing was sent: this write goes out only with the owner\'s fingerprint on these exact bytes, and then once' }
      // No approver, an approver that refuses (no passkey on this request), a passkey over other bytes, an expired one.
      for (const authorizeClass3 of [null, async () => { throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 }) },
        async input => approvalFor({ ...input, requestId: 'request-other-bytes-0' }), async input => approvalFor(input, { expiresAt: NOW - 1 }),
        async input => approvalFor(input, { tamper: true }), async () => ({ ok: false })]) {
        const result = await call(linear, body, { env, authorizeClass3 })
        assert.deepEqual([name, level, result.status, result.body], [name, level, 403, held])
      }
      // While held nothing is written; the one read that may go out is the identifier lookup, made before any approval.
      assert.deepEqual(fake.calls.filter(c => !/^query LinearDoorIssueId\(/.test(c.query)), [], `${name} at ${level}: no write reached Linear while held`)
      assert.equal(fake.calls.length, fields.id === 'YOURTEAM-398' ? 6 : 0, `${name} at ${level}: an identifier is looked up once per attempt; a UUID never`)
      const approvals = []
      const approve = async input => { approvals.push(canonicalJson(input)); return approvalFor(input) }
      const sent = await call(linear, body, { env, authorizeClass3: approve })
      assert.equal(sent.status, 200, `${name}: ${sent.text}`)
      assert.equal(sent.body.approved, reason)
      assert.deepEqual(approvals, [canonicalJson(body)], 'the approval covers exactly her bytes')
      const mutations = fake.calls.filter(c => /^mutation/.test(c.query))
      assert.equal(mutations.length, 1, name)
      assert.equal(mutations[0].query, LINEAR_ACTIONS[name].query)
      // Sent again with a fresh approval: the first answer, and nothing written twice.
      const again = await call(linear, body, { env, authorizeClass3: approve })
      assert.deepEqual(again.body, { ...sent.body, repeated: true })
      assert.equal(fake.calls.filter(c => /^mutation/.test(c.query)).length, 1)
    }
  }
})

test('an issue_update that keeps its team is open; with teamId it asks', async () => {
  const fake = fakeLinear(writeAnswers('issueUpdate'))
  const open = await call(door(fake), { action: 'issue_update', requestId: RID, id: UUID1, title: 'Renamed' })
  assert.equal(open.status, 200)
  const moved = await call(door(fake), { action: 'issue_update', requestId: 'request-0002-abcdef', id: UUID1, teamId: UUID2 })
  assert.deepEqual([moved.status, moved.body.reason], [403, 'team-move'])
})

test('level guarded: every write asks, reads do not; an absent or unknown level is guarded', async () => {
  assert.equal(linearDoorLevel({ LINEAR_DOOR_LEVEL: 'open' }), 'open')
  for (const value of [undefined, '', 'OPEN', 'opened', 'guarded']) assert.equal(linearDoorLevel({ LINEAR_DOOR_LEVEL: value }), 'guarded')
  const env = { ...ENV, LINEAR_DOOR_LEVEL: undefined }
  for (const [name, fields] of OPEN_WRITES) {
    const fake = fakeLinear(writeAnswers('x'))
    const result = await call(door(fake), { action: name, requestId: RID, ...fields }, { env })
    assert.deepEqual([name, result.status, result.body.code, result.body.reason, result.body.level], [name, 403, 'CLASS3_WEBAUTHN_REQUIRED', 'guarded-level', 'guarded'])
    // Nothing is written; the only reads are the checks made before any approval (an identifier, whose comment it is).
    const expected = [...(fields.issue === 'YOURTEAM-398' || fields.id === 'YOURTEAM-398' ? ['LinearDoorIssueId'] : []), ...(name === 'comment_update' ? ['LinearDoorCommentOwner'] : [])]
    assert.deepEqual(fake.calls.map(c => /^query (LinearDoor[A-Za-z]+)\(/.exec(c.query)?.[1] ?? c.query), expected, name)
  }
  const fake = fakeLinear(() => ({ data: { teams: { nodes: [], pageInfo: PAGE } } }))
  assert.equal((await call(door(fake), { action: 'teams' }, { env })).status, 200)
})

// ---- refused, unknown, malformed --------------------------------------------------------------------------------------
test('the refused families are not offered at all, with a plain code; raw GraphQL has no way in', async () => {
  const cases = [
    ['organization_update', 'workspace-settings'], ['workspace_settings', 'workspace-settings'], ['user_suspend', 'members'], ['user_update', 'members'],
    ['invite_create', 'members'], ['invitation_resend', 'members'], ['role_update', 'members'], ['member_remove', 'members'],
    ['api_key_create', 'api-keys'], ['apikey_delete', 'api-keys'], ['oauth_client_create', 'oauth'], ['application_update', 'oauth'],
    ['webhook_create', 'webhooks'], ['integration_create', 'integrations'], ['billing', 'billing'], ['subscription_update', 'billing'],
    ['graphql', 'raw-graphql'], ['query', 'raw-graphql'], ['mutation', 'raw-graphql'], ['raw', 'raw-graphql'],
  ]
  for (const [action, family] of cases) {
    const fake = fakeLinear()
    const result = await call(door(fake), { action, requestId: RID })
    assert.deepEqual([action, result.status, result.body.code, result.body.family], [action, 403, 'LINEAR_REFUSED', family])
    assert.deepEqual(fake.calls, [])
  }
  for (const field of ['query', 'mutation', 'graphql', 'variables', 'operationName']) {
    const fake = fakeLinear()
    const result = await call(door(fake), { action: 'issues', [field]: 'mutation { organizationDelete { success } }' })
    assert.deepEqual([field, result.status, result.body.family], [field, 403, 'raw-graphql'])
    assert.deepEqual(fake.calls, [])
  }
})

test('an unknown action or field, a bad value, a missing requestId: refused before anything is sent', async () => {
  const cases = [
    [{ action: 'issue_frobnicate' }, 400, 'LINEAR_ACTION_UNKNOWN'],
    [{ action: 'Issue', id: 'x' }, 400, 'LINEAR_ACTION_UNKNOWN'],
    [{ action: ['issue'] }, 400, 'LINEAR_ACTION_UNKNOWN'],
    [{}, 400, 'LINEAR_ACTION_UNKNOWN'],
    [{ action: 'issue', id: 'YOURTEAM-1', extra: 1 }, 400, 'LINEAR_FIELD_UNKNOWN'],
    [{ action: 'teams', requestId: RID }, 400, 'LINEAR_FIELD_UNKNOWN'],
    [{ action: 'issue' }, 400, 'LINEAR_FIELD_REQUIRED'],
    [{ action: 'issue', id: '../x' }, 400, 'LINEAR_FIELD_INVALID'],
    [{ action: 'issues', first: 51 }, 400, 'LINEAR_FIELD_INVALID'],
    [{ action: 'issues', updatedSince: 'yesterday' }, 400, 'LINEAR_FIELD_INVALID'],
    [{ action: 'comments', issue: 'A-1', document: UUID2 }, 400, 'LINEAR_FIELD_REQUIRED'],
    [{ action: 'comment', issue: UUID1, body: 'x' }, 400, 'LINEAR_REQUEST_ID_REQUIRED'],
    [{ action: 'comment', requestId: 'short', issue: UUID1, body: 'x' }, 400, 'LINEAR_REQUEST_ID_REQUIRED'],
    [{ action: 'comment', requestId: RID, issue: UUID1, body: '   ' }, 400, 'LINEAR_FIELD_INVALID'],
    [{ action: 'issue_create', requestId: RID, teamId: UUID1, title: 'two\nlines' }, 400, 'LINEAR_FIELD_INVALID'],
    [{ action: 'issue_create', requestId: RID, teamId: UUID1, title: 'x', priority: 7 }, 400, 'LINEAR_FIELD_INVALID'],
    [{ action: 'issue_update', requestId: RID, id: UUID1 }, 400, 'LINEAR_FIELD_REQUIRED'],
    [{ action: 'issue_update', requestId: RID, id: UUID1, estimate: 3 }, 400, 'LINEAR_FIELD_UNKNOWN'],
    [{ action: 'team_settings', requestId: RID, id: UUID1, cyclesEnabled: true }, 400, 'LINEAR_FIELD_UNKNOWN'],
  ]
  for (const [body, status, code] of cases) {
    const fake = fakeLinear()
    const result = await call(door(fake), body)
    assert.deepEqual([body, result.status, result.body.code], [body, status, code])
    assert.deepEqual(fake.calls, [])
  }
})

test('only the owner, same-origin, POST, JSON, at most 64 KiB, no query string', async () => {
  const fake = fakeLinear()
  const linear = door(fake)
  const body = { action: 'teams' }
  const expect = async (options, status, code) => {
    const result = await call(linear, body, options)
    assert.deepEqual([result.status, result.body.code], [status, code])
  }
  await expect({ access: null }, 401, 'OWNER_ACCESS_REQUIRED')
  await expect({ access: { ...ACCESS, type: 'access' } }, 403, 'OWNER_SESSION_REQUIRED')
  await expect({ access: { ...ACCESS, email: 'someone@example.test' } }, 403, 'OWNER_SESSION_REQUIRED')
  await expect({ access: { ...ACCESS, expires: NOW / 1000 - 1 } }, 403, 'OWNER_SESSION_REQUIRED')
  await expect({ request: post(body, { headers: { origin: 'https://evil.example' } }) }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED')
  await expect({ request: post(body, { headers: { 'sec-fetch-site': 'cross-site' } }) }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED')
  await expect({ request: new Request(ORIGIN + '/_host/linear', { method: 'GET', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } }) }, 405, 'METHOD_UNAVAILABLE')
  await expect({ request: new Request(ORIGIN + '/_host/linear?x=1', { method: 'POST', body: '{}' }) }, 404, 'NOT_FOUND')
  await expect({ request: post(body, { headers: { 'content-type': 'text/plain' } }) }, 415, 'LINEAR_JSON_REQUIRED')
  await expect({ request: post(null, { raw: '{"action":' }) }, 400, 'LINEAR_BODY_MALFORMED')
  await expect({ request: post(null, { raw: '[1]' }) }, 400, 'LINEAR_BODY_MALFORMED')
  await expect({ request: post(null, { raw: JSON.stringify({ action: 'search', text: 'x'.repeat(65 * 1024) }) }) }, 413, 'LINEAR_BODY_TOO_LARGE')
  assert.deepEqual(fake.calls, [])
})

test('not configured: status says so and names the one missing NAME; every other action is LINEAR_NOT_CONFIGURED', async () => {
  for (const env of [{ ...ENV, LINEAR_API_KEY: undefined }, { ...ENV, LINEAR_API_KEY: '' }, { ...ENV, LINEAR_API_KEY: '  ' }]) {
    const fake = fakeLinear()
    const status = await call(door(fake), { action: 'status' }, { env })
    assert.deepEqual([status.status, status.body], [200, { ok: true, action: 'status', level: 'open', configured: false, missing: 'LINEAR_API_KEY' }])
    const read = await call(door(fake), { action: 'teams' }, { env })
    assert.deepEqual([read.status, read.body], [503, { ok: false, code: 'LINEAR_NOT_CONFIGURED', missing: 'LINEAR_API_KEY' }])
    const write = await call(door(fake), { action: 'comment', requestId: RID, issue: UUID1, body: 'x' }, { env })
    assert.deepEqual([write.status, write.body.code], [503, 'LINEAR_NOT_CONFIGURED'])
    assert.deepEqual(fake.calls, [])
  }
})

// ---- idempotency and bounds -------------------------------------------------------------------------------------------
test('a repeat within 10 minutes returns the first answer and writes nothing twice; other bytes under the same requestId are refused', async () => {
  let clock = NOW
  const fake = fakeLinear(writeAnswers('commentCreate'))
  const linear = createLinearDoor({ fetchImpl: fake.fetchImpl, now: () => clock })
  const body = { action: 'comment', requestId: RID, issue: UUID1, body: 'Once.' }
  const first = await call(linear, body)
  assert.equal(first.status, 200)
  clock += 9 * 60 * 1000
  const again = await call(linear, body)
  assert.deepEqual(again.body, { ...first.body, repeated: true })
  assert.equal(fake.calls.length, 1)
  const other = await call(linear, { ...body, body: 'Twice?' })
  assert.deepEqual([other.status, other.body], [409, { ok: false, code: 'LINEAR_REQUEST_ID_REUSED', requestId: RID }])
  assert.equal(fake.calls.length, 1)
  clock += 61 * 1000
  assert.equal((await call(linear, body)).body.repeated, undefined, 'after 10 minutes the requestId is new again')
  assert.equal(fake.calls.length, 2)
})

test('two identical writes that arrive together send one; a write whose answer was lost is never sent again', async () => {
  let release
  const fake = { calls: [], fetchImpl: async (url, init) => {
    fake.calls.push(JSON.parse(init.body))
    return await new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: 'c' } } } }))) })
  } }
  const linear = door(fake)
  const body = { action: 'comment', requestId: RID, issue: UUID1, body: 'Together.' }
  const first = call(linear, body)
  await new Promise(resolve => setImmediate(resolve))
  const second = await call(linear, body)
  assert.deepEqual([second.status, second.body.code], [409, 'LINEAR_REQUEST_IN_FLIGHT'])
  release()
  assert.equal((await first).status, 200)
  assert.equal(fake.calls.length, 1)

  const lost = fakeLinear(() => ({}), { delayForever: true })
  const timed = createLinearDoor({ fetchImpl: lost.fetchImpl, now: () => NOW, upstreamTimeoutMs: 30 })
  const unknown = await call(timed, body)
  assert.deepEqual([unknown.status, unknown.body.code, unknown.body.outcome], [503, 'LINEAR_WRITE_OUTCOME_UNKNOWN', 'unknown'])
  const repeat = await call(timed, body)
  assert.deepEqual(repeat.body, { ...unknown.body, repeated: true })
  assert.equal(lost.calls.length, 1, 'the lost write is not sent again')
})

test('a held write is not remembered: the approved send with the same requestId goes through', async () => {
  const fake = fakeLinear(writeAnswers('issueDelete'))
  const linear = door(fake)
  const body = { action: 'issue_delete', requestId: RID, id: UUID1 }
  assert.equal((await call(linear, body)).status, 403)
  const sent = await call(linear, body, { authorizeClass3: input => approvalFor(input) })
  assert.equal(sent.status, 200)
  assert.equal(sent.body.repeated, undefined)
})

test('The owner\'s approval is spent last: a failed lookup, someone else\'s comment or a full hour never uses it up', async () => {
  // HEAD consumes an approval the moment authorizeClass3 accepts it; every check that can still fail comes before that.
  const approvals = []
  const approve = async input => { approvals.push(input.requestId); return approvalFor(input) }
  for (const failure of ['lookup-down', 'lookup-unknown']) {
    const fake = fakeLinear(query => {
      if (/^query LinearDoorIssueId/.test(query)) { if (failure === 'lookup-down') throw new Error('made-up network failure'); return { data: { issue: null } } }
      return { data: { issueDelete: { success: true } } }
    })
    const result = await call(door(fake), { action: 'issue_delete', requestId: `request-spent-${failure}`, id: 'YOURTEAM-398' }, { authorizeClass3: approve })
    assert.deepEqual([failure, result.status, result.body.code], [failure, ...(failure === 'lookup-down' ? [502, 'LINEAR_UPSTREAM_UNAVAILABLE'] : [404, 'LINEAR_NOT_FOUND'])])
    assert.equal(fake.calls.filter(c => /^mutation/.test(c.query)).length, 0)
  }
  const theirs = fakeLinear(() => ({ data: { viewer: { id: 'u-auma' }, comment: { id: 'c9', user: { id: 'u-owner' } } } }))
  const guarded = { ...ENV, LINEAR_DOOR_LEVEL: 'guarded' }
  const notHers = await call(door(theirs), { action: 'comment_update', requestId: 'request-spent-not-hers', id: 'c9', body: 'x' }, { env: guarded, authorizeClass3: approve })
  assert.deepEqual([notHers.status, notHers.body.code], [403, 'LINEAR_NOT_HER_COMMENT'])
  assert.deepEqual(approvals, [], 'no approval was asked for while a check could still fail')

  // Two approved writes race for the last write of the hour: the second is refused before its approval is asked for.
  const fake = fakeLinear(query => (/LinearDoorLabel/.test(query) ? { data: { issueLabelCreate: { success: true } } } : { data: { projectDelete: { success: true } } }))
  const linear = door(fake)
  // The hour holds 240 writes (was 60), so 239 fill it to one short.
  for (let i = 0; i < LINEAR_DOOR_LIMITS.writesPerHour - 1; i += 1) assert.equal((await call(linear, { action: 'label_create', requestId: `request-fill-${String(i).padStart(6, '0')}`, name: `l${i}` })).status, 200)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = async input => { approvals.push(input.requestId); await gate; return approvalFor(input) }
  const first = call(linear, { action: 'project_delete', requestId: 'request-race-first-01', id: UUID2 }, { authorizeClass3: slow })
  const second = call(linear, { action: 'project_delete', requestId: 'request-race-second-1', id: UUID1 }, { authorizeClass3: slow })
  await new Promise(resolve => setTimeout(resolve, 20))
  release()
  const answers = (await Promise.all([first, second])).sort((a, b) => a.status - b.status)
  assert.deepEqual(answers.map(a => [a.status, a.body.code ?? a.body.action]), [[200, 'project_delete'], [429, 'LINEAR_RATE']])
  assert.equal(approvals.length, 1, 'only the write that is sent spent an approval')
  assert.equal(fake.calls.filter(c => /^mutation LinearDoorProjectDelete/.test(c.query)).length, 1)
})

test('bounds: 2,400 reads and 240 writes an hour per owner session (were 600 and 60), answered LINEAR_RATE with the seconds to wait', async () => {
  assert.deepEqual([LINEAR_DOOR_LIMITS.readsPerHour, LINEAR_DOOR_LIMITS.writesPerHour, LINEAR_DOOR_LIMITS.timeoutMs], [2400, 240, 20000])
  let clock = NOW
  const fake = fakeLinear(query => (/^mutation/.test(query) ? { data: { issueLabelCreate: { success: true } } } : { data: { users: { nodes: [], pageInfo: PAGE } } }))
  const linear = createLinearDoor({ fetchImpl: fake.fetchImpl, now: () => clock })
  for (let i = 0; i < 2400; i += 1) assert.equal((await call(linear, { action: 'users' })).status, 200)
  clock += 1000
  const read = await call(linear, { action: 'users' })
  assert.deepEqual([read.status, read.body.code, read.body.retryAfterSeconds, read.body.limit], [429, 'LINEAR_RATE', 3599, '2400 reads per hour'])
  assert.equal(fake.calls.length, 2400)
  // Another owner session has its own hour.
  assert.equal((await call(linear, { action: 'users' }, { access: { ...ACCESS, session: 'made-up-session-mac-2' } })).status, 200)
  for (let i = 0; i < 240; i += 1) {
    assert.equal((await call(linear, { action: 'label_create', requestId: `request-rate-${String(i).padStart(6, '0')}`, name: `l${i}` })).status, 200)
  }
  const write = await call(linear, { action: 'label_create', requestId: 'request-rate-overflow', name: 'one too many' })
  assert.deepEqual([write.status, write.body.code, write.body.limit], [429, 'LINEAR_RATE', '240 writes per hour'])
  assert.equal(fake.calls.filter(c => /^mutation/.test(c.query)).length, 240)
  clock += LINEAR_DOOR_LIMITS.windowMs
  assert.equal((await call(linear, { action: 'users' })).status, 200, 'the hour passes')
})

// ---- Linear's failures ------------------------------------------------------------------------------------------------
test('an upstream error carries Linear\'s own class as a closed code, never its words; a parentless document says what to pass', async () => {
  const PROVIDER = 'made-up provider words that must never leave'
  const door = answer => createLinearDoor({ fetchImpl: fakeLinear(answer).fetchImpl, now: () => NOW, upstreamTimeoutMs: 30 })
  const classed = await call(door(() => ({ errors: [{ message: PROVIDER, extensions: { code: 'INPUT_ERROR', userPresentableMessage: PROVIDER } }] })), { action: 'teams' })
  assert.deepEqual([classed.status, classed.body], [502, { ok: false, code: 'LINEAR_UPSTREAM_ERROR', kind: 'INPUT_ERROR' }])
  assert.ok(!classed.text.includes('made-up'))
  // A class that is not an upper-snake code (prose, lower case, too long, not a string) never leaves.
  for (const code of [PROVIDER, 'input error', 'A'.repeat(41), 'X', 7, null]) {
    const shaped = await call(door(() => ({ errors: [{ message: PROVIDER, extensions: { code } }] })), { action: 'teams' })
    assert.deepEqual(shaped.body, { ok: false, code: 'LINEAR_UPSTREAM_ERROR' }, String(code))
  }
  const failing = () => ({ errors: [{ message: PROVIDER, extensions: { code: 'INPUT_ERROR' } }] })
  const bare = await call(door(failing), { action: 'document_create', requestId: 'request-document-bare', title: 'Round state' })
  assert.deepEqual(bare.body, { ok: false, code: 'LINEAR_UPSTREAM_ERROR', kind: 'INPUT_ERROR', next: LINEAR_NEXT.documentParent })
  const placed = await call(door(failing), { action: 'document_create', requestId: 'request-document-placed', title: 'Round state', projectId: UUID1 })
  assert.deepEqual(placed.body, { ok: false, code: 'LINEAR_UPSTREAM_ERROR', kind: 'INPUT_ERROR' }, 'with a project the hint would be wrong, so it is not said')
  assert.ok(!bare.text.includes('made-up') && !placed.text.includes('made-up'))
})

test('a Linear error, refusal, rate limit, redirect, bad answer or timeout is a closed code with no provider text', async () => {
  const PROVIDER = 'made-up provider words that must never leave'
  const cases = [
    [() => ({ errors: [{ message: PROVIDER }] }), {}, 502, 'LINEAR_UPSTREAM_ERROR'],
    [() => ({ errors: [{ message: PROVIDER, extensions: { code: 'RATELIMITED' } }] }), {}, 429, 'LINEAR_UPSTREAM_RATE_LIMITED'],
    [() => ({ errors: [{ message: PROVIDER }] }), { status: 500 }, 502, 'LINEAR_UPSTREAM_ERROR'],
    [() => ({ errors: [{ message: PROVIDER }] }), { status: 401 }, 502, 'LINEAR_UPSTREAM_REFUSED'],
    [() => ({ errors: [{ message: PROVIDER }] }), { status: 429 }, 429, 'LINEAR_UPSTREAM_RATE_LIMITED'],
    [() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' + PROVIDER } }), {}, 502, 'LINEAR_UPSTREAM_REFUSED'],
    [() => new Response('<html>' + PROVIDER), {}, 502, 'LINEAR_UPSTREAM_MALFORMED'],
    [() => ({ data: 'x' }), {}, 502, 'LINEAR_UPSTREAM_MALFORMED'],
    [() => ({ data: { teams: { nodes: 'x', pageInfo: PAGE } } }), {}, 502, 'LINEAR_UPSTREAM_MALFORMED'],
    [() => new Response('x'.repeat(LINEAR_DOOR_LIMITS.upstreamBytes + 1)), {}, 502, 'LINEAR_UPSTREAM_TOO_LARGE'],
    [() => ({}), { delayForever: true }, 502, 'LINEAR_UPSTREAM_UNAVAILABLE'],
    [() => { throw new Error(PROVIDER) }, {}, 502, 'LINEAR_UPSTREAM_UNAVAILABLE'],
  ]
  for (const [answer, options, status, code] of cases) {
    const fake = fakeLinear(answer, options)
    const linear = createLinearDoor({ fetchImpl: fake.fetchImpl, now: () => NOW, upstreamTimeoutMs: 30 })
    const result = await call(linear, { action: 'teams' })
    assert.deepEqual([code, result.status, result.body], [code, status, { ok: false, code }])
    assert.ok(!result.text.includes(PROVIDER) && !result.text.includes('made-up'))
  }
})

// ---- the key and the screen -------------------------------------------------------------------------------------------
test('an answer carrying the key or a secret shape is withheld whole; her text carrying one never goes out', async () => {
  for (const leak of [KEY, 'lin_api_' + 'A'.repeat(40), 'ghp_' + 'B'.repeat(36), '-----BEGIN PRIVATE KEY-----']) {
    const fake = fakeLinear(() => ({ data: { issue: { id: UUID1, title: 'look: ' + leak } } }))
    const result = await call(door(fake), { action: 'issue', id: UUID1 })
    assert.deepEqual([result.status, result.body.code], [502, 'LINEAR_ANSWER_WITHHELD'])
    assert.ok(!result.text.includes(leak))
  }
  for (const leak of [KEY, 'sk-proj-' + 'C'.repeat(30)]) {
    const fake = fakeLinear(writeAnswers('commentCreate'))
    const result = await call(door(fake), { action: 'comment', requestId: RID, issue: UUID1, body: `here it is ${leak}` })
    assert.deepEqual([result.status, result.body], [403, { ok: false, code: 'LINEAR_PRIVATE_CONTENT_REFUSED' }])
    assert.deepEqual(fake.calls, [])
  }
  assert.equal(linearScreenClean('plain words about tokens and keys', ENV), true)
  assert.equal(linearScreenClean('x ' + KEY, ENV), false)
  // Every configured secret is screened whatever its length, as cloud-brokers.mjs safeText screens it.
  const short = { ...ENV, MADE_UP_SECRET: 'q7Z!x' }
  assert.equal(linearScreenClean('the short one: q7Z!x', short), false)
  const fake = fakeLinear(() => ({ data: { issue: { id: UUID1, title: 'echo q7Z!x' } } }))
  const result = await call(door(fake), { action: 'issue', id: UUID1 }, { env: short })
  assert.deepEqual([result.status, result.body.code], [502, 'LINEAR_ANSWER_WITHHELD'])
  assert.ok(!result.text.includes('q7Z!x'))
})

test('the key never appears in any answer, log line or thrown error of this file, and goes only to api.linear.app in the header', () => {
  assert.ok(seen.length > 200, 'many answers were captured')
  for (const text of seen) assert.ok(!text.includes(KEY), text.slice(0, 200))
})
