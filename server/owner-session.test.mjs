/** Keyless owner-entry regressions; no live bindings, credentials, login, or network. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createWorker } from '../deploy/cloudflare/src/worker.mjs'

const env = { PUBLIC_HOST: 'owner.example', OWNER_EMAIL: 'owner@example.test', OWNER_PUBLIC_KEY_HEX: 'ab'.repeat(32) }
const request = (path, headers = {}, method = 'GET') => new Request('https://owner.example' + path, { method, headers: { accept: 'text/html', ...headers } })
const worker = createWorker({ networkFetch: () => { assert.fail('no external request is allowed') } })

for (const path of ['/', '/index.html', '/preview.html']) {
  test('Round26 owner entry ignores query values for ' + path, async () => {
    const plain = await worker.fetch(request(path), env)
    const expected = await plain.text()
    for (const query of ['?ui=1', '?debug=1', '?', '?token=SECRET_QUERY_TOKEN&next=https%3A%2F%2Fevil.example', '?x=%3Cscript%3ESECRET_QUERY_TOKEN%3C%2Fscript%3E']) {
      const response = await worker.fetch(request(path + query), env)
      assert.equal(response.status, 401)
      assert.match(response.headers.get('content-type'), /^text\/html/)
      assert.equal(await response.text(), expected)
      assert.equal(response.headers.get('set-cookie'), null)
      assert.equal(response.headers.get('location'), null)
    }
    assert.doesNotMatch(expected, /SECRET_QUERY_TOKEN|evil\.example/)
    assert.equal(plain.headers.get('cache-control'), 'no-store')
    assert.equal(plain.headers.get('referrer-policy'), 'no-referrer')
    const policy = plain.headers.get('content-security-policy')
    for (const tag of ['script', 'style']) {
      const content = expected.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'))[1]
      assert.ok(policy.includes("'sha256-" + createHash('sha256').update(content).digest('base64') + "'"))
    }
    assert.match(policy, /frame-ancestors 'none'/)
    assert.doesNotMatch(expected, /<(?:script|link|img)[^>]+(?:src|href)=/i)
  })
}

test('Round26 only explicit HTML document GETs receive sign-in', async () => {
  for (const [path, headers, method] of [
    ['/door/deepseek/v1/messages?ui=1', {}, 'GET'], ['/api/health?ui=1', {}, 'GET'],
    ['/assets/main.js?ui=1', {}, 'GET'], ['/missing.html?ui=1', {}, 'GET'],
    ['/?ui=1', { accept: 'application/json' }, 'GET'], ['/?ui=1', { accept: '*/*' }, 'GET'],
    ['/?ui=1', { accept: 'text/html;q=0' }, 'GET'], ['/?ui=1', { 'sec-fetch-mode': 'cors' }, 'GET'],
    ['/?ui=1', { 'sec-fetch-dest': 'iframe' }, 'GET'], ['/?ui=1', {}, 'POST'], ['/?ui=1', {}, 'HEAD'],
  ]) {
    const response = await worker.fetch(request(path, headers, method), env)
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { ok: false, code: 'OWNER_ACCESS_REQUIRED' })
  }
  const navigation = await worker.fetch(request('/?ui=1', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }), env)
  assert.match(navigation.headers.get('content-type'), /^text\/html/)
})

test('Round26 owner entry retains host, origin, and configuration refusals', async () => {
  for (const [incoming, config, status, code] of [
    [new Request('http://owner.example/?ui=1', { headers: { accept: 'text/html' } }), env, 403, 'HOST_REFUSED'],
    [request('/?ui=1'), { ...env, PUBLIC_HOST: 'other.example' }, 403, 'HOST_REFUSED'],
    [request('/?ui=1', { origin: 'https://evil.example' }), env, 403, 'ORIGIN_REFUSED'],
    [request('/?ui=1'), { PUBLIC_HOST: env.PUBLIC_HOST }, 503, 'OWNER_ACCESS_NOT_CONFIGURED'],
  ]) {
    const response = await worker.fetch(incoming, config)
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { ok: false, code })
  }
})
