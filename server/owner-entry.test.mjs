/** Synthetic owner-entry checks only. Browser fragments stay local and are absent from the HTTP request. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { createWorker, OWNER_PASSKEY } from '../deploy/cloudflare/src/worker.mjs'

const ORIGIN = 'https://round30-entry.example.invalid'
const navigation = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

function fixture() {
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: 'ab'.repeat(32),
    get HEAD() { assert.fail('Unauthenticated requests must not read HEAD') },
    get MIRROR() { assert.fail('Unauthenticated requests must not read mirror') },
    get ASSETS() { assert.fail('Unauthenticated requests must not read assets') },
  }
  const worker = createWorker({ verifyAccess: async () => null, networkFetch: () => assert.fail('No network allowed') })
  return (url, headers = navigation, method = 'GET') => worker.fetch(new Request(url, { headers, method }), env)
}

for (const path of ['/', '/index.html', '/preview.html']) {
  test('Round30 entry navigation ignores synthetic fragments without reflecting them: ' + path, async () => {
    const request = fixture()
    const plain = await request(ORIGIN + path)
    const expected = await plain.text()
    for (const suffix of ['#session', '#', '#token=SECRET_FRAGMENT_TOKEN',
      '?token=SECRET_QUERY_TOKEN#session', '?next=https%3A%2F%2Fevil.example#SECRET_FRAGMENT_TOKEN']) {
      const browserLocation = new URL(ORIGIN + path + suffix)
      const wireUrl = new URL(browserLocation)
      wireUrl.hash = ''
      assert.equal(wireUrl.hash, '', 'the browser does not send its fragment in the HTTP URL')
      // Request constructors can retain a fragment in synthetic tests. Both forms classify by pathname.
      for (const url of [browserLocation, wireUrl]) {
        const response = await request(url)
        assert.equal(response.status, 401)
        assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
        assert.equal(response.headers.get('set-cookie'), null)
        assert.equal(response.headers.get('location'), null)
        assert.equal(await response.text(), expected)
      }
    }
    assert.doesNotMatch(expected, /SECRET_FRAGMENT_TOKEN|SECRET_QUERY_TOKEN|evil\.example/)
    // Since an earlier commit ("invite link front door") the page reads the fragment once, for a public `#invite=` receipt only
    // (deploy/cloudflare/src/worker.mjs OWNER_SIGNIN_SCRIPT). It still never reads the query or the whole address.
    assert.doesNotMatch(expected, /location\.(?:search|href)/, 'sign-in never reads URL values as credentials')
    assert.equal(expected.match(/location\.hash/g)?.length, 1, 'the one fragment read is the invite reader')
    // And it does nothing with any other fragment: the page script, run as a browser would run it, behaves exactly as it
    // does with no fragment, never touches the address bar, never reads the query, and never writes a URL value anywhere.
    const baseline = await runEntryPage(expected, new URL(ORIGIN + path))
    assert.deepEqual(baseline.requests, [OWNER_PASSKEY.challenge], 'the page fetches one sign-in challenge on load')
    for (const suffix of ['#session', '#', '#token=SECRET_FRAGMENT_TOKEN',
      '?token=SECRET_QUERY_TOKEN#session', '?next=https%3A%2F%2Fevil.example#SECRET_FRAGMENT_TOKEN']) {
      const run = await runEntryPage(expected, new URL(ORIGIN + path + suffix))
      assert.deepEqual(run.reads.filter(name => ['search', 'href'].includes(name)), [], suffix)
      assert.equal(run.reads.filter(name => name === 'hash').length, 1, suffix)
      assert.deepEqual(run.addressBar, [], suffix)
      assert.deepEqual(run.replaced, [], suffix)
      assert.equal(run.passkeyPrompts, 0, suffix)
      assert.deepEqual(run.requests, baseline.requests, suffix)
      assert.deepEqual(run.bodies, baseline.bodies, suffix)
      assert.equal(run.html, baseline.html, suffix)
      assert.doesNotMatch(JSON.stringify(run.bodies) + run.html, /SECRET_FRAGMENT_TOKEN|SECRET_QUERY_TOKEN|evil\.example/, suffix)
    }
  })
}

/** Run the sign-in page's one script against a recording fake browser; the network never answers. */
async function runEntryPage(html, browserLocation) {
  const dom = new JSDOM(html, { url: browserLocation.href, pretendToBeVisual: true })
  try {
    const reads = [], addressBar = [], replaced = [], requests = [], bodies = []
    let passkeyPrompts = 0
    const location = new Proxy({ origin: browserLocation.origin, pathname: browserLocation.pathname, hash: browserLocation.hash,
      search: browserLocation.search, href: browserLocation.href, replace: destination => replaced.push(destination) }, {
      get(target, name) { reads.push(name); return target[name] },
    })
    const window = { PublicKeyCredential: function PublicKeyCredential() {}, name: '', location,
      addEventListener: dom.window.addEventListener.bind(dom.window),
      history: { replaceState: (_state, _unused, destination) => addressBar.push(destination) } }
    const scripts = dom.window.document.querySelectorAll('script')
    assert.equal(scripts.length, 1)
    runInNewContext(scripts[0].textContent, {
      document: dom.window.document, window, navigator: { credentials: { get: () => { passkeyPrompts++; return new Promise(() => {}) } } },
      AbortController, AbortSignal, URL, btoa, atob, TextDecoder, TextEncoder, Date, performance,
      setTimeout: () => 0, clearTimeout: () => {},
      fetch: (request, options = {}) => { requests.push(String(request)); bodies.push(options.body ?? null); return new Promise(() => {}) },
    })
    await new Promise(resolve => setImmediate(resolve))
    return { reads, addressBar, replaced, requests, bodies, passkeyPrompts, html: dom.window.document.documentElement.outerHTML }
  } finally { dom.window.close() }
}

test('Round30 fragments cannot turn protected paths or non-document requests into owner-entry HTML', async () => {
  const request = fixture()
  for (const [path, headers, method] of [
    ['/api/health#session', navigation, 'GET'],
    ['/door/deepseek/v1/messages#session', navigation, 'GET'],
    ['/assets/app.js#session', navigation, 'GET'],
    ['/missing.html#session', navigation, 'GET'],
    ['/#session', { ...navigation, accept: 'application/json' }, 'GET'],
    ['/#session', { ...navigation, accept: 'text/html;q=0' }, 'GET'],
    ['/#session', { ...navigation, 'sec-fetch-mode': 'cors' }, 'GET'],
    ['/#session', { ...navigation, 'sec-fetch-dest': 'iframe' }, 'GET'],
    ['/#session', navigation, 'POST'],
    ['/#session', navigation, 'HEAD'],
  ]) {
    const syntheticUrl = new URL(ORIGIN + path), wireUrl = new URL(syntheticUrl)
    wireUrl.hash = ''
    for (const url of [syntheticUrl, wireUrl]) {
      const response = await request(url, headers, method)
      assert.equal(response.status, 401)
      assert.equal(response.headers.get('content-type'), 'application/json')
      assert.deepEqual(await response.json(), { ok: false, code: 'OWNER_ACCESS_REQUIRED' })
    }
  }
})
