import test from 'node:test'
import assert from 'node:assert/strict'
import { createCrewRelay } from '../crew-relay.mjs'
import { createCrewRelayTool } from '../crew-relay-tool.mjs'

const ACCESS = { type: 'owner', email: 'owner@example.test' }
const ENV = { LINEAR_API_KEY: 'test-key-not-a-real-secret' }
const ISSUE = { id: 'issue-1', identifier: 'YOUR_TEAM-0', title: 'CREW RELAY' }
const FIRST = { id: 'c1', body: 'first', createdAt: '2026-11-12T10:00:00.000Z', user: { name: 'Lead' } }
const SECOND = { id: 'c2', body: 'second', createdAt: '2026-11-12T11:00:00.000Z', user: { name: 'Lead' } }

function issueResponse(comments = [FIRST]) {
  return { data: { issues: { nodes: [{ ...ISSUE, comments: { nodes: comments } }] } } }
}
function commentResponse() {
  return { data: { commentCreate: { success: true, comment: { id: 'c9', createdAt: '2026-11-12T12:00:00.000Z' } } } }
}
function recorder(responses) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
    const next = responses.shift()
    if (!next) throw new Error('fetch called more times than expected')
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImpl }
}
function request(method = 'GET', body) {
  return new Request('https://node.example.invalid/_host/crew-relay', {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
async function answer(promise) {
  try {
    const response = await promise
    return { status: response.status, body: await response.json() }
  } catch (error) {
    return { status: error.status ?? 500, body: { ok: false, code: error.code ?? error.message } }
  }
}

test('refuses a caller that is not the owner', async () => {
  const { fetchImpl, calls } = recorder([])
  const relay = createCrewRelay({ fetchImpl })
  const result = await answer(relay(request(), ENV, null))
  assert.equal(result.status, 401)
  assert.equal(result.body.code, 'OWNER_ACCESS_REQUIRED')
  assert.equal(calls.length, 0)
})

test('is unavailable before the key is configured', async () => {
  const { fetchImpl, calls } = recorder([])
  const relay = createCrewRelay({ fetchImpl })
  const result = await answer(relay(request(), {}, ACCESS))
  assert.equal(result.status, 503)
  assert.equal(result.body.code, 'RELAY_NOT_CONFIGURED')
  assert.equal(calls.length, 0)
})

test('reads the fixed issue and its comments through a fixed query', async () => {
  const { fetchImpl, calls } = recorder([issueResponse()])
  const relay = createCrewRelay({ fetchImpl })
  const result = await answer(relay(request(), ENV, ACCESS))
  assert.equal(result.status, 200)
  assert.equal(result.body.issue.identifier, 'YOUR_TEAM-0')
  assert.equal(result.body.comments.length, 1)
  assert.equal(result.body.comments[0].author, 'Lead')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.linear.app/graphql')
  assert.equal(calls[0].init.headers.authorization, ENV.LINEAR_API_KEY)
  assert.match(calls[0].body.query, /issues\(filter: \{ team: \{ key: \{ eq: \$teamKey \} \}, number: \{ eq: \$number \} \}/)
  assert.deepEqual(calls[0].body.variables, { teamKey: 'YOUR_TEAM', number: 0, comments: 50 })
})

test('returns only comments newer than the cursor', async () => {
  const { fetchImpl } = recorder([issueResponse([FIRST, SECOND])])
  const relay = createCrewRelay({ fetchImpl })
  const target = new URL('https://node.example.invalid/_host/crew-relay')
  target.searchParams.set('after', '2026-11-12T10:30:00.000Z')
  const result = await answer(relay(new Request(target), ENV, ACCESS))
  assert.deepEqual(result.body.comments.map(comment => comment.id), ['c2'])
})

test('posts exactly one comment after the owner asks', async () => {
  const { fetchImpl, calls } = recorder([issueResponse(), commentResponse()])
  const relay = createCrewRelay({ fetchImpl })
  const result = await answer(relay(request('POST', { body: 'READY 8: Auma, loop running.' }), ENV, ACCESS))
  assert.equal(result.status, 201)
  assert.equal(result.body.comment.id, 'c9')
  assert.equal(calls.length, 2)
  assert.match(calls[1].body.query, /commentCreate\(input: \{ issueId: \$issueId, body: \$body \}\)/)
  assert.deepEqual(calls[1].body.variables, { issueId: 'issue-1', body: 'READY 8: Auma, loop running.' })
})

test('refuses any operation other than one body field', async () => {
  const { fetchImpl, calls } = recorder([])
  const relay = createCrewRelay({ fetchImpl })
  for (const body of [{ op: 'read' }, { body: 'x', issue: 'YOUR_TEAM-1' }, { body: 'x', query: '{ viewer { id } }' }]) {
    const result = await answer(relay(request('POST', body), ENV, ACCESS))
    assert.equal(result.status, 400)
    assert.equal(result.body.code, 'RELAY_OPERATION_UNKNOWN')
  }
  assert.equal(calls.length, 0)
})

test('refuses a comment over the length cap before any network call', async () => {
  const { fetchImpl, calls } = recorder([])
  const relay = createCrewRelay({ fetchImpl })
  const result = await answer(relay(request('POST', { body: 'x'.repeat(4001) }), ENV, ACCESS))
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'RELAY_COMMENT_LENGTH')
  assert.equal(calls.length, 0)
})

test('rate limits a second post from the same isolate', async () => {
  let clock = 1_000_000
  const { fetchImpl, calls } = recorder([issueResponse(), commentResponse()])
  const relay = createCrewRelay({ fetchImpl, now: () => clock })
  const first = await answer(relay(request('POST', { body: 'one' }), ENV, ACCESS))
  assert.equal(first.status, 201)
  clock += 1000
  const second = await answer(relay(request('POST', { body: 'two' }), ENV, ACCESS))
  assert.equal(second.status, 429)
  assert.equal(second.body.code, 'RELAY_RATE_LIMITED')
  assert.equal(calls.length, 2)
})

test('the organ-side tool reads with a cursor and says one body', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const tool = createCrewRelayTool({ origin: 'https://node.example.invalid', fetchImpl })
  assert.equal(tool.name, 'crew_relay')
  await tool.execute({ op: 'read', after: '2026-11-12T10:00:00.000Z' })
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, 'https://node.example.invalid/_host/crew-relay?after=2026-11-12T10%3A00%3A00.000Z')
  await tool.execute({ op: 'say', body: 'READY 8: Auma.' })
  assert.equal(calls[1].method, 'POST')
  assert.deepEqual(calls[1].body, { body: 'READY 8: Auma.' })
  await assert.rejects(() => tool.execute({ op: 'graphql', query: '{ viewer { id } }' }), /RELAY_OPERATION_UNKNOWN/)
})
