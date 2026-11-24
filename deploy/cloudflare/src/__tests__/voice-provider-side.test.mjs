/**
 * What the provider says about its own side, in the owner's status read
 * (voice-provider-side.mjs). The reads are best effort, closed, bounded, and never carry a transcript, an id or a key.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PROVIDER_SIDE, PROVIDER_SIDE_READS, providerSideNotAsked, providerWords, readEnding, readProviderSide, readSubscription } from '../voice-provider-side.mjs'
import { ORIGIN, fixture } from './voice-bridge-fakes.mjs'

const KEY = 'sk_test_key_never_shown_0123456789'
const RESOURCE = 'seng_abc123'
const AT = 1794985508000

const SUBSCRIPTION = { tier: 'creator', character_count: 99000, character_limit: 100000, can_extend_character_limit: false, status: 'active', has_open_invoices: false,
  next_character_count_reset_unix: 1795000000, voice_limit: 30, currency: 'usd', billing_period: 'monthly_period' }
const LIST = { conversations: [
  { agent_id: 'agent_x', conversation_id: 'conv_newest1', start_time_unix_secs: 1794985513, call_duration_secs: 2, message_count: 0, status: 'failed', call_successful: 'unknown', agent_name: 'Private Name' },
  { agent_id: 'agent_x', conversation_id: 'conv_second2', start_time_unix_secs: 1794985221, call_duration_secs: 2, message_count: 0, status: 'done', call_successful: 'unknown' },
  { agent_id: 'agent_x', conversation_id: 'conv_third33', start_time_unix_secs: 1794974833, call_duration_secs: 74, message_count: 9, status: 'done', call_successful: 'success' },
  { agent_id: 'agent_x', conversation_id: 'conv_fourth4', start_time_unix_secs: 1794974586, call_duration_secs: 202, message_count: 21, status: 'done', call_successful: 'success' },
], has_more: true, next_cursor: 'cursor-value' }
const SECRET_WORDS = 'the owner said something private about his family'
const DETAIL = {
  conv_newest1: { agent_id: 'agent_x', conversation_id: 'conv_newest1', status: 'failed', transcript: [{ role: 'user', message: SECRET_WORDS }],
    metadata: { start_time_unix_secs: 1794985513, call_duration_secs: 2, termination_reason: 'Override for field \'first_message\' is not allowed by config.', error: { code: 1008, reason: 'Override for field first_message is not allowed' }, warnings: ['one', 'two', 'three', 'four'] } },
  conv_second2: { agent_id: 'agent_x', conversation_id: 'conv_second2', status: 'done', transcript: [], metadata: { termination_reason: '', error: null } },
  conv_third33: { agent_id: 'agent_x', conversation_id: 'conv_third33', status: 'done', transcript: [{ role: 'agent', message: SECRET_WORDS }], metadata: { termination_reason: 'client disconnected' } },
}

/** A fake provider: `routes` maps a path (without the query) to a Response factory. Every call is recorded. */
function provider(routes = {}) {
  const calls = []
  const networkFetch = async (url, init) => {
    calls.push({ url, init })
    const parsed = new URL(url)
    const route = routes[parsed.pathname] ?? routes['*']
    if (route) return route(parsed, init)
    if (parsed.pathname === '/v1/user/subscription') return Response.json(SUBSCRIPTION)
    if (parsed.pathname === '/v1/convai/conversations') return Response.json(LIST)
    const id = parsed.pathname.split('/').at(-1)
    return Object.hasOwn(DETAIL, id) ? Response.json(DETAIL[id]) : Response.json({ detail: 'not found' }, { status: 404 })
  }
  return { calls, networkFetch }
}
const read = (fake, extra = {}) => readProviderSide({ networkFetch: fake.networkFetch, apiKey: KEY, resourceId: RESOURCE, now: () => AT, ...extra })

test('providerWords: plain letters, digits and punctuation only, one space between words, cut to the bound', () => {
  assert.equal(providerWords('Override for field \'first_message\' is not allowed by config.'), 'Override for field \'first_message\' is not allowed by config.')
  assert.equal(providerWords('  quota\texceeded\n\n<script>alert(1)</script> {"a":1} [x] `y` $z  '), 'quota exceeded script alert(1) /script a :1 x y z')
  assert.equal(providerWords('x'.repeat(500)).length, PROVIDER_SIDE.textChars)
  assert.equal(providerWords('‮\u0000\u001b[31m'), '31m')
  for (const value of ['', '   ', '\n\t', '{}[]<>', null, undefined, 7, {}, ['a']]) assert.equal(providerWords(value), null)
})

test('readSubscription and readEnding keep closed values only', () => {
  assert.deepEqual(readSubscription(SUBSCRIPTION), { status: 'active', tier: 'creator', used: 99000, limit: 100000, canGoOver: false, openInvoices: false, resetAtSeconds: 1795000000 })
  assert.deepEqual(readSubscription({ status: 'weird', tier: 'A Tier With Spaces', character_count: -1, character_limit: 1.5, can_extend_character_limit: 'yes', has_open_invoices: 1 }),
    { status: null, tier: null, used: null, limit: null, canGoOver: null, openInvoices: null, resetAtSeconds: null })
  for (const value of [null, undefined, 'x', 3, []]) assert.equal(readSubscription(value), null)
  assert.deepEqual(readEnding(DETAIL.conv_newest1), { status: 'failed', endReason: 'Override for field \'first_message\' is not allowed by config.', errorCode: 1008,
    errorReason: 'Override for field first_message is not allowed', warnings: ['one', 'two', 'three'] })
  assert.deepEqual(readEnding({ status: 'odd', metadata: { termination_reason: 9, error: 'text', warnings: 'no' } }), { status: null, endReason: null, errorCode: null, errorReason: null, warnings: [] })
  assert.deepEqual(readEnding({}), { status: null, endReason: null, errorCode: null, errorReason: null, warnings: [] })
  for (const value of [null, undefined, 'x', 3, []]) assert.equal(readEnding(value), null)
})

test('the three reads: the account, the newest conversations, and how the newest three ended, in the provider\'s words', async () => {
  const fake = provider()
  const out = await read(fake)
  assert.deepEqual(out, {
    readAtMs: AT,
    account: { read: 'ok', status: 'active', tier: 'creator', used: 99000, limit: 100000, canGoOver: false, openInvoices: false, resetAtSeconds: 1795000000 },
    conversations: { read: 'ok', rows: [
      { startedAtSeconds: 1794985513, durationSeconds: 2, messages: 0, status: 'failed', result: 'unknown',
        ending: { read: 'ok', status: 'failed', endReason: 'Override for field \'first_message\' is not allowed by config.', errorCode: 1008, errorReason: 'Override for field first_message is not allowed', warnings: ['one', 'two', 'three'] } },
      { startedAtSeconds: 1794985221, durationSeconds: 2, messages: 0, status: 'done', result: 'unknown', ending: { read: 'ok', status: 'done', endReason: null, errorCode: null, errorReason: null, warnings: [] } },
      { startedAtSeconds: 1794974833, durationSeconds: 74, messages: 9, status: 'done', result: 'success', ending: { read: 'ok', status: 'done', endReason: 'client disconnected', errorCode: null, errorReason: null, warnings: [] } },
      { startedAtSeconds: 1794974586, durationSeconds: 202, messages: 21, status: 'done', result: 'success', ending: { read: 'not-asked' } },
    ] },
  })
  // Only GETs, only to the provider, the key only in its header; the list asks for this resource and the bound.
  assert.deepEqual(fake.calls.map(call => call.url).sort(), [
    'https://api.elevenlabs.io/v1/convai/conversations/conv_newest1', 'https://api.elevenlabs.io/v1/convai/conversations/conv_second2', 'https://api.elevenlabs.io/v1/convai/conversations/conv_third33',
    `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${RESOURCE}&page_size=${String(PROVIDER_SIDE.listed)}`, 'https://api.elevenlabs.io/v1/user/subscription'].sort())
  for (const call of fake.calls) {
    assert.deepEqual([call.init.method, call.init.redirect, call.init.headers['xi-api-key'], Object.keys(call.init.headers)], ['GET', 'manual', KEY, ['xi-api-key']])
    assert.equal(call.init.signal instanceof AbortSignal, true)
  }
  // Never what was said, an id, a name, a cursor or the key.
  const shown = JSON.stringify(out)
  for (const secret of [SECRET_WORDS, 'private', 'conv_', 'agent_x', 'Private Name', 'cursor-value', KEY, 'sk_test', RESOURCE]) assert.equal(shown.includes(secret), false, secret)
})

test('each way a read can fail has its own closed word, and one failing read leaves the other standing', async () => {
  const kinds = [
    [() => Response.json({ detail: 'x' }, { status: 401 }), 'status-401'], [() => Response.json({}, { status: 403 }), 'status-403'], [() => Response.json({}, { status: 404 }), 'status-404'],
    [() => Response.json({}, { status: 429 }), 'status-429'], [() => Response.json({}, { status: 503 }), 'status-5xx'], [() => Response.json({}, { status: 418 }), 'status-other'],
    [() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }), 'status-other'],
    [() => { throw new Error('socket hang up') }, 'network'],
    [() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'shape'],
    [() => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }), 'shape'],
    [() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(PROVIDER_SIDE.bodyBytes + 1) } }), 'too-large'],
    [() => new Response('x'.repeat(PROVIDER_SIDE.bodyBytes + 10), { status: 200, headers: { 'content-type': 'application/json' } }), 'too-large'],
  ]
  for (const [answer, word] of kinds) {
    assert.equal(PROVIDER_SIDE_READS.includes(word), true)
    const account = await read(provider({ '/v1/user/subscription': answer }))
    assert.deepEqual([account.account, account.conversations.read, account.conversations.rows.length], [{ read: word }, 'ok', 4], word)
    const list = await read(provider({ '/v1/convai/conversations': answer }))
    assert.deepEqual([list.account.read, list.conversations], ['ok', { read: word, rows: [] }], word)
    const ending = await read(provider({ '/v1/convai/conversations/conv_newest1': answer }))
    assert.deepEqual([ending.conversations.rows[0].ending, ending.conversations.rows[1].ending.read], [{ read: word }, 'ok'], word)
  }
  // Shapes that parse but are not what is documented.
  assert.deepEqual((await read(provider({ '/v1/user/subscription': () => Response.json(['a']) }))).account, { read: 'shape' })
  assert.deepEqual((await read(provider({ '/v1/convai/conversations': () => Response.json({ conversations: 'none' }) }))).conversations, { read: 'shape', rows: [] })
  assert.deepEqual((await read(provider({ '/v1/convai/conversations/conv_newest1': () => Response.json('text') }))).conversations.rows[0].ending, { read: 'shape' })
  // A listed row without a usable id is dropped; no more than `listed` rows and `detailed` endings are ever asked.
  const many = { conversations: [{ conversation_id: 'bad id!' }, { conversation_id: 7 }, ...Array.from({ length: 12 }, (_, index) => ({ conversation_id: `conv_n${String(index)}`, status: 'done' }))] }
  const fake = provider({ '/v1/convai/conversations': () => Response.json(many), '*': () => Response.json({ status: 'done', metadata: {} }) })
  const bounded = await read(fake)
  assert.equal(bounded.conversations.rows.length, PROVIDER_SIDE.listed - 2)
  assert.equal(fake.calls.filter(call => call.url.includes('/conversations/')).length, PROVIDER_SIDE.detailed)
})

test('one deadline for all of it: a provider that never answers costs the deadline, not more, and nothing throws', async () => {
  const never = (_, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  const started = Date.now()
  const out = await read(provider({ '*': never }), { deadlineMs: 40 })
  assert.equal(Date.now() - started < 2000, true)
  assert.deepEqual(out, { readAtMs: AT, account: { read: 'timeout' }, conversations: { read: 'timeout', rows: [] } })
  // The list answers, the endings hang: the rows stand, each ending says timeout.
  const half = await read(provider({ '/v1/convai/conversations/conv_newest1': never, '/v1/convai/conversations/conv_second2': never, '/v1/convai/conversations/conv_third33': never }), { deadlineMs: 40 })
  assert.deepEqual(half.conversations.rows.map(row => row.ending.read), ['timeout', 'timeout', 'timeout', 'not-asked'])
  assert.equal(half.account.read, 'ok')
})

test('nothing is asked without a transport, a key and a resource id of the known shape', async () => {
  const fake = provider()
  for (const options of [{ networkFetch: undefined }, { apiKey: '' }, { apiKey: null }, { resourceId: 'not-a-resource' }, { resourceId: '' }, { resourceId: 'seng_abc/../x' }]) {
    assert.deepEqual(await read(fake, options), providerSideNotAsked(AT))
  }
  assert.equal(fake.calls.length, 0)
  assert.deepEqual(providerSideNotAsked(5), { readAtMs: 5, account: { read: 'not-asked' }, conversations: { read: 'not-asked', rows: [] } })
})

test('the owner\'s status carries it: through the Worker, with the provider\'s answers, and never for anyone else', async () => {
  const answers = parsed => {
    if (parsed.pathname === '/v1/user/subscription') return Response.json(SUBSCRIPTION)
    if (parsed.pathname === '/v1/convai/conversations') return Response.json({ conversations: LIST.conversations.slice(0, 1), has_more: false })
    return Response.json(DETAIL.conv_newest1)
  }
  const fx = fixture({ providerSide: answers })
  const response = await fx.ownerDoor({ body: { action: 'managed_status' } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.providerSide.account, { read: 'ok', status: 'active', tier: 'creator', used: 99000, limit: 100000, canGoOver: false, openInvoices: false, resetAtSeconds: 1795000000 })
  assert.deepEqual(body.providerSide.conversations, { read: 'ok', rows: [{ startedAtSeconds: 1794985513, durationSeconds: 2, messages: 0, status: 'failed', result: 'unknown',
    ending: { read: 'ok', status: 'failed', endReason: 'Override for field \'first_message\' is not allowed by config.', errorCode: 1008, errorReason: 'Override for field first_message is not allowed', warnings: ['one', 'two', 'three'] } }] })
  assert.equal(Number.isSafeInteger(body.providerSide.readAtMs), true)
  assert.equal(JSON.stringify(body).includes(SECRET_WORDS), false)
  // A fixture that says nothing answers 404 for these reads: the status still answers, with the closed word.
  const plain = await (await fixture().ownerDoor({ body: { action: 'managed_status' } })).json()
  assert.deepEqual([plain.providerSide.account, plain.providerSide.conversations], [{ read: 'status-404' }, { read: 'status-404', rows: [] }])
  // The switch off: nothing is asked of the provider.
  const off = fixture({ env: { VOICE_MANAGED: '0' }, providerSide: answers })
  const offBody = await (await off.ownerDoor({ body: { action: 'managed_status' } })).json()
  assert.deepEqual([offBody.providerSide.account, offBody.providerSide.conversations, off.calls.provider.length], [{ read: 'not-asked' }, { read: 'not-asked', rows: [] }, 0])
  // Not the owner, or not from her own page: the same refusals as before, and the provider is never asked.
  const stranger = fixture({ access: null, providerSide: answers })
  assert.equal((await stranger.ownerDoor({ body: { action: 'managed_status' } })).status >= 400, true)
  assert.equal(stranger.calls.provider.length, 0)
  const cross = fixture({ providerSide: answers })
  assert.equal((await cross.ownerDoor({ body: { action: 'managed_status' }, headers: { origin: 'https://elsewhere.invalid' } })).status, 403)
  assert.equal(cross.calls.provider.length, 0)
  assert.equal(typeof ORIGIN, 'string')
})
