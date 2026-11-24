import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCrewRelayTool } from '../crew-relay-tool.mjs'

const ORIGIN = 'https://node.example.invalid'

function answer({ status = 200, json, text }) {
  return {
    status,
    async text() { return text === undefined ? JSON.stringify(json) : text },
  }
}

function toolWith(response, calls = []) {
  return createCrewRelayTool({
    origin: ORIGIN,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response },
  })
}

test('a non-JSON answer is reported, never parsed as JSON', async () => {
  const tool = toolWith(answer({ status: 502, text: '<html>bad gateway</html>' }))
  const out = await tool.execute({ op: 'read' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'RELAY_ANSWER_NOT_JSON')
  assert.equal(out.status, 502)
})

test('an oversized answer is refused before parsing', async () => {
  const tool = toolWith(answer({ status: 200, text: 'x'.repeat(256 * 1024 + 1) }))
  const out = await tool.execute({ op: 'read' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'RELAY_ANSWER_TOO_LARGE')
})

test('a JSON refusal passes through unchanged', async () => {
  const refusal = { ok: false, code: 'RELAY_UPSTREAM_RATE_LIMITED' }
  const tool = toolWith(answer({ status: 429, json: refusal }))
  assert.deepEqual(await tool.execute({ op: 'read' }), refusal)
})

test('read is one call and carries the after cursor', async () => {
  const calls = []
  const page = { ok: true, comments: [], gap: true }
  const tool = toolWith(answer({ json: page }), calls)
  const out = await tool.execute({ op: 'read', after: 'c-42' })
  assert.deepEqual(out, page)
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/_host/crew-relay')
  assert.equal(url.searchParams.get('after'), 'c-42')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.credentials, 'same-origin')
})

test('say posts exactly the body', async () => {
  const calls = []
  const tool = toolWith(answer({ json: { ok: true, comment: { id: 'c-1' } } }), calls)
  const out = await tool.execute({ op: 'say', body: 'Hello crew' })
  assert.equal(out.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(calls[0].init.body), { body: 'Hello crew' })
})

test('an unknown op is refused', async () => {
  const tool = toolWith(answer({ json: { ok: true } }))
  await assert.rejects(() => tool.execute({ op: 'delete' }), /RELAY_OPERATION_UNKNOWN/)
})

test('a transport failure is RELAY_UNREACHABLE, not a thrown error', async () => {
  const tool = createCrewRelayTool({
    origin: ORIGIN,
    fetchImpl: async () => { throw new Error('socket closed') },
  })
  const out = await tool.execute({ op: 'read' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'RELAY_UNREACHABLE')
})
