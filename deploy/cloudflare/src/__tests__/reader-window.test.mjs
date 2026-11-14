/**
 * A browser marked as a reader (`__Host-aukora_window=reader`) changes nothing at her
 * edge, through the real Worker (worker.mjs THREADSYNC hook) with a fake HEAD and MIRROR. Unmarked requests are byte for
 * byte as before: they reach the same object with the same path. The mark refuses only the listed routes that change her
 * node; his sign-in, AUMLOK and fingerprint routes stay open to a reader (MUSTs 1 and 2).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'
import { hasReaderMark, READER_WINDOW_COOKIE, READER_WINDOW_SENTENCE, readerWindowRefusal } from '../reader-window.mjs'

const ORIGIN = 'https://reader-window.example.invalid'
const SEED = 'a'.repeat(64)

// The mark exists only while thread sync is switched on, so the cases above the switch's own cases run
// with `THREAD_SYNC = "on"`; the switch's cases (at the end) run the same requests with it unset, `pull`, `off`, `ON`.
const SWITCHED_ON = Object.freeze({ THREAD_SYNC: 'on' })

function fixture(extra = SWITCHED_ON) {
  const reached = []
  const namespace = { idFromName: name => name, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    reached.push(`${request.method} ${path}`)
    if (path === '/_head/bootstrap-status') return Response.json({ ok: true, phase: 'complete', seedId: SEED, ballId: 'b'.repeat(64), epoch: 172 })
    if (path === '/_mirror/bootstrap-status') return Response.json({ ok: true, phase: 'ready', seedId: SEED, ballId: 'b'.repeat(64), epoch: 172 })
    return Response.json({ ok: true, stub: path })
  } }) }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64), HEAD: namespace, MIRROR: namespace, ...extra }
  const worker = createWorker({ verifyAccess: async () => ({ type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }) })
  const call = (path, { method = 'POST', cookie, body, headers = {} } = {}) => worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) }), env)
  return { call, reached }
}

const MARK = 'other=1; __Host-aukora_window=reader; theme=dark'
/** What a sibling subdomain can plant with `Domain=example.invalid` (review MUST 1): a plain name, never the `__Host-` one. */
const PLANTED = 'other=1; aukora_window=reader; theme=dark'

const refusedCode = async response => (response.status === 403 ? (await response.clone().json().catch(() => ({}))).code : null)

test('the mark is read exactly: `__Host-aukora_window=reader` among the cookies, nothing looser', () => {
  const marked = cookie => hasReaderMark(new Request(ORIGIN, { headers: cookie === null ? {} : { cookie } }))
  assert.equal(READER_WINDOW_COOKIE, '__Host-aukora_window')
  assert.equal(marked(MARK), true)
  assert.equal(marked('__Host-aukora_window=reader'), true)
  assert.equal(marked(null), false)
  assert.equal(marked('__Host-aukora_window=writer'), false)
  assert.equal(marked('__Host-aukora_window=readers'), false)
  assert.equal(marked('x__Host-aukora_window=reader'), false)
  assert.equal(marked(`${'a=b; '.repeat(4000)}__Host-aukora_window=reader`), false, 'an oversized header is not read (cheap)')
})

test('review MUST 1: a plain `aukora_window=reader` (a cookie any example.invalid subdomain can set) is ignored', async () => {
  const marked = cookie => hasReaderMark(new Request(ORIGIN, { headers: { cookie } }))
  assert.equal(marked('aukora_window=reader'), false)
  assert.equal(marked(PLANTED), false)
  assert.equal(marked('__Secure-aukora_window=reader'), false)
  const f = fixture()
  for (const [path, method, body] of [['/_host/wake', 'POST', { action: 'trigger' }], ['/door/deepseek/chat/completions', 'POST', {}], ['/_mirror/delta', 'POST', {}], ['/_head/promotion-status', 'GET']]) {
    const response = await f.call(path, { method, cookie: PLANTED, body })
    assert.notEqual(await refusedCode(response), 'READER_WINDOW', `${method} ${path} with a planted plain cookie`)
  }
  assert.ok(f.reached.includes('POST /_host/wake'), f.reached.join(', '))
  assert.ok(f.reached.includes('GET /_head/promotion-status'), f.reached.join(', '))
})

test('a marked browser: Wake now, the wake timer, a save, her lease for a thread, a thread append, a door, a turn and the two changing GETs are refused before any object is reached', async () => {
  const f = fixture()
  const refused = [
    ['/_host/wake', 'POST', { action: 'trigger' }],
    ['/_host/wake', 'POST', { action: 'configure', enabled: true, intervalMs: 600000 }],
    ['/_mirror/lease', 'POST', {}],
    ['/_head/lease', 'POST', { action: 'acquire', ownerPeerId: 'reader-peer' }], // HEAD lease-changing operations are refused for readers
    ['/_mirror/delta', 'POST', {}],
    ['/_thread/append', 'POST', {}],
    ['/door/deepseek/chat/completions', 'POST', {}],
    ['/door/deepseek/models', 'GET'],
    ['/_host/voice', 'POST', {}],
    ['/_head/transcript', 'POST', { action: 'turn_start' }],
    ['/_head/ball', 'POST', {}],
    ['/_head/promotion-status', 'GET'],
    ['/_head/transcript', 'GET'],
  ]
  for (const [path, method, body] of refused) {
    const response = await f.call(path, { method, cookie: MARK, body })
    assert.equal(response.status, 403, `${method} ${path}`)
    assert.deepEqual(await response.json(), { ok: false, code: 'READER_WINDOW', message: READER_WINDOW_SENTENCE })
  }
  assert.deepEqual(f.reached, [], 'no object was reached for any refused request')
})

test('review MUST 2: his fingerprint and AUMLOK routes stay open to a reader-marked browser and reach HEAD', async () => {
  const f = fixture()
  const open = [
    '/_host/aumlok/approve', '/_host/aumlok/bind', '/_host/aumlok/unseal', '/_host/aumlok/refresh', '/_host/aumlok/redeem',
    '/_host/aumlok/device-confirm', '/_host/aumlok/device-code', '/_host/aumlok/device-remove',
    '/_head/promote', '/_head/stage', '/_head/night-grant', '/_head/night-grant/promote',
  ]
  for (const path of open) {
    const response = await f.call(path, { cookie: MARK, body: {} })
    assert.notEqual(await refusedCode(response), 'READER_WINDOW', `POST ${path}`)
    assert.ok(f.reached.includes(`POST ${path}`), `POST ${path} reached HEAD: ${f.reached.join(', ')}`)
  }
  // The owner grant answers from the edge itself; it is judged by its own rules, never by the mark.
  const grant = await f.call('/_host/owner-grant', { cookie: MARK, body: {} })
  assert.notEqual(await refusedCode(grant), 'READER_WINDOW')
  // An approved publish and an approved Nostr provisioning carry his approval: the mark leaves them to HEAD's checks.
  const approval = { 'x-x6-class3-approval': 'approval-under-test' }
  for (const path of ['/_head/ball', '/_head/transcript']) {
    const response = await f.call(path, { cookie: MARK, body: { action: 'nostr_provision' }, headers: approval })
    assert.notEqual(await refusedCode(response), 'READER_WINDOW', `approved POST ${path}`)
    assert.ok(f.reached.includes(`POST ${path}`), `approved POST ${path} reached HEAD: ${f.reached.join(', ')}`)
  }
})

test('a marked browser still reads: the wake state, her lease, her ball pass through unchanged', async () => {
  const f = fixture()
  for (const path of ['/_host/wake', '/_head/lease', '/_head/ball']) {
    const response = await f.call(path, { method: 'GET', cookie: MARK })
    assert.notEqual(await refusedCode(response), 'READER_WINDOW', path)
  }
  assert.ok(f.reached.some(line => line === 'GET /_host/wake' || line.endsWith('/_host/wake')), f.reached.join(', '))
  assert.ok(f.reached.includes('GET /_head/ball'), f.reached.join(', '))
})

test('an unmarked browser is untouched: the same POST and the same changing GET reach the object exactly as before', async () => {
  const marked = fixture()
  const plain = fixture()
  const a = await plain.call('/_host/wake', { method: 'POST', body: { action: 'trigger' } })
  const b = await plain.call('/_head/promotion-status', { method: 'GET' })
  assert.notEqual(a.status, 403)
  assert.notEqual(b.status, 403)
  assert.ok(plain.reached.includes('POST /_host/wake'), plain.reached.join(', '))
  assert.ok(plain.reached.includes('GET /_head/promotion-status'), plain.reached.join(', '))
  // With the mark the very same calls reach nothing.
  await marked.call('/_host/wake', { method: 'POST', cookie: MARK, body: { action: 'trigger' } })
  await marked.call('/_head/promotion-status', { method: 'GET', cookie: MARK })
  assert.deepEqual(marked.reached, [])
})

test('the pure check: reads, sign-in and the real AUMLOK and promotion paths are never refused; only the listed routes are', () => {
  const at = (path, method, headers = {}) => readerWindowRefusal(new Request(ORIGIN + path, { method, headers: { cookie: MARK, ...headers }, ...(method === 'POST' ? { body: '{}' } : {}) }), new URL(ORIGIN + path), SWITCHED_ON)
  assert.equal(at('/_auth/owner', 'POST'), null)
  assert.equal(at('/_host/aumlok/approve', 'POST'), null)
  assert.equal(at('/_host/aumlok/bind', 'POST'), null)
  assert.equal(at('/_head/promote', 'POST'), null)
  assert.equal(at('/_head/stage', 'POST'), null)
  assert.equal(at('/_host/owner-grant', 'POST'), null)
  assert.equal(at('/_thread/index', 'GET'), null)
  assert.equal(at('/_mirror/export', 'GET'), null)
  assert.equal(at('/_vault/blob/' + 'c'.repeat(64), 'GET'), null)
  assert.equal(at('/_head/ws', 'GET'), null)
  assert.equal(at('/_head/ball', 'POST', { 'x-x6-class3-approval': 'x' }), null)
  assert.equal(at('/_thread/append', 'POST')?.status, 403)
  assert.equal(at('/_thread/import', 'POST', { 'x-x6-class3-approval': 'x' })?.status, 403, 'an approval never makes a reader her thread writer')
  assert.equal(at('/_mirror/lease', 'POST')?.status, 403)
  assert.equal(at('/api/body/run', 'POST')?.status, 403)
  assert.equal(at('/_host/cloud-body', 'POST')?.status, 403)
  assert.equal(at('/_head/transcript', 'HEAD')?.status, 403)
  assert.equal(at('/_head/transcript', 'GET', { 'x-x6-class3-approval': 'x' })?.status, 403, 'the changing GET stays refused')
  assert.equal(at('/door/voice', 'GET')?.status, 403)
})

// ── Inert while the switch is unset ───────────────────────────────────────────────────────────────────
// With `THREAD_SYNC` unset (or anything but exactly `on`), a request carrying a planted reader mark is treated exactly as
// on main: compared with the same request carrying no mark, the same status, the same body and the same objects reached.

/** Every env the switch is NOT on in: unset, and each near miss. */
const SWITCH_NOT_ON = [['unset', {}], ['pull', { THREAD_SYNC: 'pull' }], ['off', { THREAD_SYNC: 'off' }], ['ON', { THREAD_SYNC: 'ON' }],
  ['" on"', { THREAD_SYNC: ' on' }], ['true', { THREAD_SYNC: true }]]
/** The closed list: every route a marked browser is refused while on. */
const CLOSED_LIST = [
  ['/_host/wake', 'POST', { action: 'trigger' }], ['/_mirror/lease', 'POST', {}], ['/_head/lease', 'POST', { action: 'acquire', ownerPeerId: 'reader-peer' }],
  ['/_mirror/delta', 'POST', {}], ['/_thread/append', 'POST', {}],
  ['/door/deepseek/chat/completions', 'POST', {}], ['/door/deepseek/models', 'GET'], ['/_host/voice', 'POST', {}],
  ['/_head/transcript', 'POST', { action: 'turn_start' }], ['/_head/ball', 'POST', {}], ['/_head/promotion-status', 'GET'], ['/_head/transcript', 'GET'],
]

for (const [name, extra] of SWITCH_NOT_ON) {
  test(`switch ${name}: a planted \`__Host-aukora_window=reader\` changes nothing at the edge (as on main)`, async () => {
    const marked = fixture(extra)
    const plain = fixture(extra)
    for (const [path, method, body] of CLOSED_LIST) {
      const a = await marked.call(path, { method, cookie: MARK, body })
      const b = await plain.call(path, { method, body })
      assert.equal(a.status, b.status, `${method} ${path}`)
      assert.equal(await a.text(), await b.text(), `${method} ${path}`)
      assert.equal(readerWindowRefusal(new Request(ORIGIN + path, { method, headers: { cookie: MARK }, ...(method === 'POST' ? { body: '{}' } : {}) }), new URL(ORIGIN + path), extra), null)
    }
    assert.deepEqual(marked.reached, plain.reached)
    assert.ok(marked.reached.includes('POST /_host/wake') && marked.reached.includes('POST /_mirror/delta') && marked.reached.includes('GET /_head/promotion-status'), marked.reached.join(', '))
  })
}

test('control: the same marked requests ARE refused once the switch is exactly on (so the cases above can fail)', async () => {
  const f = fixture(SWITCHED_ON)
  for (const [path, method, body] of CLOSED_LIST) assert.equal(await refusedCode(await f.call(path, { method, cookie: MARK, body })), 'READER_WINDOW', `${method} ${path}`)
  assert.deepEqual(f.reached, [])
})

// ── The switch reaches the page in the boot document, and only while on ─────────────────────────────────
const DOCUMENT = '<!doctype html>\n<html lang="en"><head data-x="1"><meta charset="utf-8"><title>Auma</title></head><body><div id="root"></div></body></html>\n'

function documentFixture(extra) {
  const asked = []
  const ASSETS = { fetch: async request => {
    const path = new URL(request.url).pathname
    asked.push(`${request.method} ${path}`)
    if (path === '/preview.html') return new Response(request.method === 'HEAD' ? null : DOCUMENT, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(new TextEncoder().encode(DOCUMENT).byteLength), etag: '"doc-1"' } })
    if (path === '/assets/app-AbCdEf12.js') return new Response('console.log(1)\n', { headers: { 'content-type': 'text/javascript' } })
    return new Response('missing', { status: 404 })
  } }
  const f = fixture({ ...extra, ASSETS })
  const get = (path, method = 'GET') => f.call(path, { method, headers: { accept: 'application/json' } })
  return { get, asked }
}

for (const [name, extra] of SWITCH_NOT_ON) {
  test(`switch ${name}: the boot document is served byte for byte as the asset (no meta, its length and etag kept)`, async () => {
    const d = documentFixture(extra)
    for (const path of ['/', '/index.html', '/preview.html']) {
      const response = await d.get(path)
      assert.equal(response.status, 200, path)
      assert.equal(await response.text(), DOCUMENT, path)
      assert.equal(response.headers.get('etag'), '"doc-1"', path)
      assert.equal(response.headers.get('content-length'), String(new TextEncoder().encode(DOCUMENT).byteLength), path)
    }
    assert.deepEqual(d.asked, ['GET /preview.html', 'GET /preview.html', 'GET /preview.html'])
  })
}

test('switch on: the boot document carries one `aukora-thread-sync` meta right after its <head>; nothing else changes', async () => {
  const d = documentFixture(SWITCHED_ON)
  const want = DOCUMENT.replace('<head data-x="1">', '<head data-x="1"><meta name="aukora-thread-sync" content="on">')
  for (const path of ['/', '/index.html', '/preview.html']) {
    const response = await d.get(path)
    assert.equal(response.status, 200, path)
    assert.equal(await response.text(), want, path)
    assert.equal(response.headers.get('etag'), null, 'the bytes changed, so the asset\'s etag is not sent')
    assert.equal(response.headers.get('content-length'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  // Not the document, not a GET, not a 200: untouched.
  assert.equal(await (await d.get('/assets/app-AbCdEf12.js')).text(), 'console.log(1)\n')
  const head = await d.get('/', 'HEAD')
  assert.equal(head.headers.get('etag'), '"doc-1"')
  assert.equal((await d.get('/nothing-here.txt')).status, 404)
})

test('the edge half: a browser whose document carried no mode sets no mark, so with the switch on its requests are treated as unmarked', async () => {
  // Its page runs nothing of thread sync (webworker-runtime tests/x6/thread-sync-switch.spec.ts) and so never writes
  // the cookie: its writes reach her objects as any unmarked browser's do.
  const f = fixture(SWITCHED_ON)
  const plain = fixture({})
  for (const [path, method, body] of CLOSED_LIST) {
    const a = await f.call(path, { method, body })
    const b = await plain.call(path, { method, body })
    assert.equal(a.status, b.status, `${method} ${path}`)
    assert.notEqual(await refusedCode(a), 'READER_WINDOW')
  }
  assert.deepEqual(f.reached, plain.reached)
})

// ── Review SHOULD 2: an assets binding that redirects /preview.html to /preview (default html_handling) ──────────────
function redirectingDocumentFixture(extra) {
  const asked = []
  const ASSETS = { fetch: async request => {
    const path = new URL(request.url).pathname
    asked.push(`${request.method} ${path}`)
    if (path === '/preview.html') return new Response(null, { status: 307, headers: { location: '/preview' } })
    if (path === '/preview') return new Response(DOCUMENT, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"doc-1"' } })
    if (path === '/notes') return new Response('<head>plain</head>', { headers: { 'content-type': 'text/plain' } })
    return new Response('missing', { status: 404 })
  } }
  const f = fixture({ ...extra, ASSETS })
  return { get: path => f.call(path, { method: 'GET', headers: { accept: 'application/json' } }), asked }
}

test('review SHOULD 2: switch on: the redirect is passed through untouched and the /preview document it leads to carries the meta', async () => {
  const d = redirectingDocumentFixture(SWITCHED_ON)
  for (const path of ['/', '/index.html', '/preview.html']) {
    const response = await d.get(path)
    assert.equal(response.status, 307, path)
    assert.equal(response.headers.get('location'), '/preview', path)
  }
  const page = await d.get('/preview')
  assert.equal(page.status, 200)
  assert.equal(await page.text(), DOCUMENT.replace('<head data-x="1">', '<head data-x="1"><meta name="aukora-thread-sync" content="on">'))
  assert.equal(page.headers.get('etag'), null)
  // A non-HTML answer is never rewritten, even on a boot path's neighbour.
  assert.equal(await (await d.get('/notes')).text(), '<head>plain</head>')
})

for (const [name, extra] of SWITCH_NOT_ON) {
  test(`review SHOULD 2: switch ${name}: the /preview document is served byte for byte`, async () => {
    const d = redirectingDocumentFixture(extra)
    const page = await d.get('/preview')
    assert.equal(await page.text(), DOCUMENT)
    assert.equal(page.headers.get('etag'), '"doc-1"')
  })
}
