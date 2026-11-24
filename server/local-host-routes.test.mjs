/** Exercise the host's real route callback with synthetic dependencies, never booting it or reading the vault. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { createLocalMessagesRequestHandler } from './messages-store.mjs'

const source = readFileSync(new URL('./local-host.mjs', import.meta.url), 'utf8')
const origin = 'http://127.0.0.1:4610'
const callbackSource = source.slice(source.indexOf('const server = http.createServer('), source.indexOf('// WebSocket server on'))

function routeFixture({ hostAllowed = true } = {}) {
  const replies = []
  let settled = 0, identityAccesses = 0
  const forbidden = () => { identityAccesses++; throw new Error('Identity dispatch must not run') }
  const handler = runInNewContext(callbackSource + '\nserver', {
    http: { createServer: callback => callback }, URL, HOST: '127.0.0.1', PORT: 4610,
    lifecycle: { trackHttp: () => () => { settled++ } },
    verifyHostAndOrigin: () => ({ ok: hostAllowed, reason: 'synthetic invalid host' }),
    sendJson: (_response, status, body, headers) => replies.push({ status, body, headers }),
    parseCookies: forbidden, readAumlokBody: forbidden, aumlokRequestAction: forbidden,
    localEnrollment: { context: forbidden }, localAumlok: { complete: forbidden, challenge: forbidden },
  })
  return { replies, handler, get settled() { return settled }, get identityAccesses() { return identityAccesses } }
}

test('local invite routes return a non-passkey 501 before identity, body, or capability dispatch', async () => {
  const fixture = routeFixture()
  for (const pathname of ['/_host/aumlok/redeem', '/_host/aumlok/invites']) {
    for (const method of ['GET', 'POST', 'PUT', 'OPTIONS']) {
      for (const query of ['', '?unexpected=1']) {
        await fixture.handler({ method, url: pathname + query, headers: { host: '127.0.0.1:4610' } }, {})
        const reply = fixture.replies.at(-1)
        assert.equal(reply.status, 501)
        assert.equal(reply.body.ok, false)
        assert.equal(reply.body.code, 'AUMLOK_EDGE_ONLY_ROUTE')
        assert.equal(reply.headers.Connection, 'close')
        assert.equal(reply.headers['X-Content-Type-Options'], 'nosniff')
      }
    }
  }
  assert.equal(fixture.identityAccesses, 0)
  assert.equal(fixture.settled, 16)
})

test('edge-only route refusal preserves the local host and origin check', async () => {
  const fixture = routeFixture({ hostAllowed: false })
  await fixture.handler({ method: 'POST', url: '/_host/aumlok/redeem', headers: {} }, {})
  assert.equal(fixture.replies[0].status, 403)
  assert.equal(fixture.identityAccesses, 0)
  assert.equal(fixture.settled, 1)
})

test('both local status aliases expose the actual host runtime without starting the host', async () => {
  const start = source.indexOf('async function localMessagesStatus()')
  const end = source.indexOf('const localWake =', start)
  const readStatus = runInNewContext(source.slice(start, end) + '\nlocalMessagesStatus', {
    ballHeadStore: { read: async () => null, inspectLease: async () => ({ lease: null }) },
    localWake: { status: async () => ({ enabled: false }) }, MIRROR_DIR: 'synthetic-memory-only',
    readLocalAuraInputs: async () => ({ aura: null, auraShadow: null }),
    readLocalPredictionStatus: async () => null,
  })
  const handler = createLocalMessagesRequestHandler({ sessionCapability: 'synthetic-capability', allowedOrigins: [origin],
    verifyHostAndOrigin: () => ({ ok: true }), readStatus })
  for (const pathname of ['/__x6/status', '/api/x61/status']) {
    const response = await handler({ method: 'GET', headers: { host: '127.0.0.1:4610', 'x-x6-capability': 'synthetic-capability' } }, new URL(pathname, origin))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).runtime, 'local')
  }
})
