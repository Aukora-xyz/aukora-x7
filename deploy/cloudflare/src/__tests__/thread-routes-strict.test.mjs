/**
 * The new public JSON routes refuse the content-type, encoding,
 * declared-length and query combinations their neighbours refuse:
 *   - the vault (vault.mjs readBody): a content-encoding other than identity is 400; a declared content-length that is
 *     not a plain number is 400; a body whose length differs from its declared content-length is 400; a query on a
 *     route that takes none is 404 NOT_FOUND;
 *   - the estate and owner-grant routes (worker.mjs): a JSON body needs `content-type: application/json`.
 * Each combination below is one assertion, on the route that accepted it before:
 *   POST /_mirror/lease (thread-mount.mjs routeLease): content-type, encoding, malformed length, length mismatch,
 *     a bare `?`;
 *   POST /_thread/import, /_thread/retract, /_thread/keep (thread-log.mjs readJson): content-type, encoding, malformed
 *     length, length mismatch, any query;
 *   POST /_thread/append (thread-log.mjs readBody): encoding, length mismatch, a query key it does not read, a repeated key;
 *   GET /_thread/index, /_thread/manifest, /_thread/tail: a query key the route does not read, a repeated key.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createThreadMount } from '../thread-mount.mjs'
import { handleThreadRequest } from '../thread-log.mjs'

const ORIGIN = 'https://her.example.invalid'
const ID = 'a'.repeat(64)
const LEASE = `${'b'.repeat(32)}.1`

/** The thread handler with a MIRROR that must never be reached by a refused request. */
async function thread(path, { method = 'POST', headers = {}, body } = {}) {
  const calls = []
  const url = new URL(ORIGIN + path)
  const request = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) })
  const response = await handleThreadRequest({ request, url, mirror: { call: async (op, input) => { calls.push(op); return { status: 404, body: { ok: false, code: 'THREAD_UNKNOWN' } } } },
    parts: { head: async () => null, put: async () => ({}), get: async () => null }, rescues: { get: async () => null } })
  return { status: response.status, code: (await response.json()).code, calls }
}

/** The lease route through the mount, with a MIRROR that records every forward. */
async function lease(path, { headers = {}, body }) {
  const forwards = []
  const env = { ARCHIVE_BUCKET: { get: async () => null, head: async () => null, put: async () => null },
    MIRROR: { idFromName: name => name, get: () => ({ fetch: async request => { forwards.push(await request.text()); return Response.json({ ok: true, lease: null }) } }) } }
  const url = new URL(ORIGIN + path)
  const response = await createThreadMount().handle({ request: new Request(url, { method: 'POST', headers, body }), url, env, ready: true, seedId: 'c'.repeat(64), access: { type: 'owner' } })
  return { status: response.status, code: (await response.json()).code, forwards }
}

const JSON_TYPE = { 'content-type': 'application/json' }
const leaseBody = JSON.stringify({ action: 'status', clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tabId: 't', label: 'Rescue page' })

test('POST /_mirror/lease refuses what its neighbours refuse, before anything is forwarded', async () => {
  const ok = await lease('/_mirror/lease', { headers: JSON_TYPE, body: leaseBody })
  assert.deepEqual([ok.status, ok.forwards.length], [200, 1], 'the well-formed request is forwarded')
  for (const [name, path, headers, status, code] of [
    ['no content-type', '/_mirror/lease', {}, 400, 'LEASE_REQUEST_INVALID'],
    ['text/plain', '/_mirror/lease', { 'content-type': 'text/plain' }, 400, 'LEASE_REQUEST_INVALID'],
    ['gzip encoding', '/_mirror/lease', { ...JSON_TYPE, 'content-encoding': 'gzip' }, 400, 'LEASE_REQUEST_INVALID'],
    ['a malformed declared length', '/_mirror/lease', { ...JSON_TYPE, 'content-length': '12x' }, 400, 'LEASE_REQUEST_INVALID'],
    ['a declared length that is not the body', '/_mirror/lease', { ...JSON_TYPE, 'content-length': String(leaseBody.length + 5) }, 400, 'LEASE_REQUEST_INVALID'],
    ['a bare ?', '/_mirror/lease?', JSON_TYPE, 404, 'NOT_FOUND'],
  ]) {
    const got = await lease(path, { headers, body: leaseBody })
    assert.deepEqual([got.status, got.code, got.forwards.length], [status, code, 0], name)
  }
})

test('the JSON thread routes refuse what their neighbours refuse, before MIRROR is called', async () => {
  const body = JSON.stringify({ path: '/dsh/home/auma/session/messages.jsonl', rescue: 'e'.repeat(32) })
  for (const route of ['/_thread/import', '/_thread/retract', '/_thread/keep']) {
    for (const [name, suffix, headers, status, code] of [
      ['no content-type', '', { 'x-thread-lease': LEASE }, 400, 'THREAD_REQUEST_INVALID'],
      ['text/plain', '', { 'x-thread-lease': LEASE, 'content-type': 'text/plain' }, 400, 'THREAD_REQUEST_INVALID'],
      ['gzip encoding', '', { 'x-thread-lease': LEASE, ...JSON_TYPE, 'content-encoding': 'gzip' }, 400, 'THREAD_REQUEST_INVALID'],
      ['a malformed declared length', '', { 'x-thread-lease': LEASE, ...JSON_TYPE, 'content-length': '1e3' }, 400, 'THREAD_REQUEST_INVALID'],
      ['a declared length that is not the body', '', { 'x-thread-lease': LEASE, ...JSON_TYPE, 'content-length': String(body.length - 3) }, 400, 'THREAD_REQUEST_INVALID'],
      ['a query', '?x=1', { 'x-thread-lease': LEASE, ...JSON_TYPE }, 404, 'NOT_FOUND'],
    ]) {
      const got = await thread(route + suffix, { headers, body })
      assert.deepEqual([got.status, got.code, got.calls.length], [status, code, 0], `${route}: ${name}`)
    }
  }
})

test('append and the GET thread routes refuse an encoding, a length mismatch, a query key they do not read and a repeated key', async () => {
  const bytes = '{"x":1}\n'
  const append = `/_thread/append?p=1&id=${ID}&at=0`
  const appendHeaders = { 'x-thread-lease': LEASE, 'x-thread-have': `${'0'.repeat(64)}.${'0'.repeat(64)}`, 'x-thread-sha256': 'd'.repeat(64), 'content-type': 'application/octet-stream' }
  for (const [name, path, headers, status, code] of [
    ['gzip encoding', append, { ...appendHeaders, 'content-encoding': 'gzip' }, 400, 'THREAD_REQUEST_INVALID'],
    ['a declared length that is not the body', append, { ...appendHeaders, 'content-length': '99' }, 400, 'THREAD_REQUEST_INVALID'],
    ['a key it does not read', append + '&extra=1', appendHeaders, 404, 'NOT_FOUND'],
    ['a repeated key', append + '&at=5', appendHeaders, 404, 'NOT_FOUND'],
  ]) {
    const got = await thread(path, { headers, body: bytes })
    assert.deepEqual([got.status, got.code, got.calls.length], [status, code, 0], `append: ${name}`)
  }
  for (const [name, path] of [
    ['index: a key it does not read', '/_thread/index?limit=5&page=2'],
    ['index: a repeated key', '/_thread/index?limit=5&limit=6'],
    ['manifest: a key it does not read', `/_thread/manifest?id=${ID}&after=x`],
    ['manifest: a repeated key', `/_thread/manifest?id=${ID}&id=${ID}`],
    ['tail: a key it does not read', `/_thread/tail?id=${ID}&page=1`],
    ['tail: a repeated key', `/_thread/tail?id=${ID}&max=5&max=6`],
  ]) {
    const got = await thread(path, { method: 'GET' })
    assert.deepEqual([got.status, got.code, got.calls.length], [404, 'NOT_FOUND', 0], name)
  }
  // The well-formed reads still reach MIRROR.
  for (const path of ['/_thread/index?limit=5', `/_thread/manifest?id=${ID}&page=0`, `/_thread/tail?id=${ID}&before=0&max=5`]) {
    const got = await thread(path, { method: 'GET' })
    assert.equal(got.calls.length, 1, path)
  }
})
