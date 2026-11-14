/** A staged Cloudflare write reads as plainly as a GitHub one: why it needs the fingerprint, the method, the
 * path, the query and a readable body (or every multipart part); after approval it is sent once; an unknown outcome says
 * to check Cloudflare. Every host answer here is a local fixture; no passkey, Cloudflare or network is real. */
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, class3Action, type Class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'

// The passkey ceremony itself (approveClass3) is stood in for, as repo-proposal-release.client.spec.tsx does; its own specs
// cover it. Everything after it (the exact binding, the one send, the words) is the real code.
const approvals: Class3Action[] = []
vi.mock('../src/client/spatial/aumlok/class3-approval.ts', async (original) => {
  const real = await original<typeof import('../src/client/spatial/aumlok/class3-approval.ts')>()
  return { ...real, approveClass3: async (action: Class3Action) => {
    approvals.push(action)
    return { ok: true, token: 'stand-in-approval', expiresAt: Date.now() + 60_000, action, hostRemainingMs: 60_000, receivedAt: 0 }
  } }
})
const {
  approveAndSendOutward, CLOUDFLARE_REASON_WHY, CLOUDFLARE_WHY, outwardMaybeSent, outwardWords, parseStagedOutward, STAGED_OUTWARD_SCHEMA,
} = await import('../src/client/spatial/aumlok/outward-class3.ts')

const P1 = { family: 'P1', reason: 'live-zone' }
const file = (body: unknown, more: Record<string, unknown> = {}) => JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1,
  tool: 'x6_cloudflare', method: 'POST', pathname: '/_host/cloudflare', body, protection: P1, ...more })
const dns = { action: 'api', method: 'PATCH', path: '/zones/abc/dns_records/rec1', query: { a: 1 }, body: { content: '192.0.2.9', proxied: true } }
const worker = { action: 'api', method: 'PUT', path: '/accounts/{account}/workers/scripts/your-node', body: 'export default {}', bodyKind: 'text', contentType: 'application/javascript' }
const module = { action: 'api', method: 'PUT', path: '/accounts/{account}/workers/scripts/your-node', bodyKind: 'multipart', parts: [
  { name: 'metadata', contentType: 'application/json', json: { main_module: 'worker.js', bindings: [{ type: 'plain_text', name: 'A', text: 'b' }] } },
  { name: 'worker.js', filename: 'worker.js', contentType: 'application/javascript+module', text: 'export default {}' },
] }

describe('the staged Cloudflare request on the owner\'s card', () => {
  it('shows why, the method, the path, the query and a readable body as rows', () => {
    const words = outwardWords(parseStagedOutward(file(dns))!)
    expect(words.summary).toBe('Cloudflare: PATCH /zones/abc/dns_records/rec1')
    expect(words.rows[0]).toEqual(['why', CLOUDFLARE_REASON_WHY['P1/live-zone']])
    expect(words.rows).toEqual(expect.arrayContaining([['method', 'PATCH'], ['path', '/zones/abc/dns_records/rec1'],
      ['query', JSON.stringify({ a: 1 }, null, 2)], ['body', JSON.stringify(dns.body, null, 2)]]))
    const text = outwardWords(parseStagedOutward(file(worker))!)
    expect(text.rows).toEqual(expect.arrayContaining([['body', 'export default {}'], ['bodyKind', 'text'], ['contentType', 'application/javascript']]))
  })

  it('says why in plain words for each family, naming the family the edge could not classify', () => {
    const why = (protection: Record<string, unknown>) => outwardWords(parseStagedOutward(file(dns, { protection }))!).rows[0]
    expect(why({ family: 'P1', reason: 'live-worker' })).toEqual(['why', 'It changes your live home\'s code: the Worker that serves it.'])
    expect(why({ family: 'P2', reason: 'keys' })).toEqual(['why', 'It changes who holds keys to your Cloudflare account: what can act as you there.'])
    expect(why({ family: 'P3', reason: 'zone-deletion' })).toEqual(['why', 'It deletes a whole zone: its address, records and settings. That cannot be undone.'])
    expect(why({ family: 'account-wide-unclassified', reason: 'unclassified', apiFamily: 'load_balancers' }))
      .toEqual(['why', 'It is an account-wide setting not yet classified, so it asks you first (Cloudflare family: load_balancers).'])
    // A reason word the card does not know yet is said by its family's sentence.
    expect(why({ family: 'P1', reason: 'not-yet-known' })).toEqual(['why', CLOUDFLARE_WHY.P1])
    for (const words of [...Object.values(CLOUDFLARE_WHY), ...Object.values(CLOUDFLARE_REASON_WHY)]) expect(words).not.toMatch(/token/i)
  })

  it('shows every multipart part: its name, type, file name and whole content', () => {
    const words = outwardWords(parseStagedOutward(file(module))!)
    expect(words.rows).toEqual(expect.arrayContaining([
      ['bodyKind', 'multipart'],
      ['part 1 (metadata) type', 'application/json'],
      // Job 6: in canonicalJson's key order (bindings before main_module), the order of the bytes that leave.
      ['part 1 (metadata) content', '{\n  "bindings": [\n    {\n      "name": "A",\n      "text": "b",\n      "type": "plain_text"\n    }\n  ],\n  "main_module": "worker.js"\n}'],
      ['part 2 (worker.js) type', 'application/javascript+module · file worker.js'],
      ['part 2 (worker.js) content', 'export default {}'],
    ]))
    expect(new Set(words.rows.map(([name]) => name)).size).toBe(words.rows.length)
  })

  it('offers nothing it would not describe exactly: a read, another action, an extra key, the wrong door, no reason', () => {
    for (const body of [{ ...dns, method: 'GET' }, { ...dns, action: 'status' }, { ...dns, extra: 1 }, { ...dns, path: 'zones' }, { ...dns, method: 7 },
      { ...module, parts: 'x' }, { ...module, parts: [1] }]) {
      expect(parseStagedOutward(file(body)), JSON.stringify(body)).toBeNull()
    }
    expect(parseStagedOutward(file(dns, { pathname: '/_host/github' }))).toBeNull()
    expect(parseStagedOutward(file(dns, { tool: 'x6_github' }))).toBeNull()
    for (const protection of [undefined, null, {}, { family: 'P9', reason: 'x' }, { family: 'P1' }, { family: 'P1', reason: 'Live!' },
      { family: 'P1', reason: 'live-zone', apiFamily: 'x' }, { family: 'P1', reason: 'live-zone', extra: 1 },
      { family: 'account-wide-unclassified', reason: 'unclassified', apiFamily: 'Bad Family' }]) {
      expect(parseStagedOutward(file(dns, { protection })), JSON.stringify(protection)).toBeNull()
    }
    // A GitHub request never carries a reason field.
    expect(parseStagedOutward(JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1, tool: 'x6_github', method: 'POST', pathname: '/_host/github',
      body: { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 'T', body: 'B' } }, protection: P1 }))).toBeNull()
  })

  it('approves the exact bytes once, sends them to /_host/cloudflare once, and an unknown outcome says to check Cloudflare', async () => {
    const staged = parseStagedOutward(file(dns))!
    // The reason he reads is inside the bytes he approves.
    const approved = { ...dns, expect: P1 }
    expect(staged.canonical).toBe(canonicalJson(approved))
    const run = async (answer: () => Response) => {
      approvals.length = 0
      const sent: Array<{ url: string; body: unknown; approval: string | null }> = []
      const fetchImpl: typeof fetch = async (resource, init) => {
        const headers = new Headers(init?.headers)
        sent.push({ url: typeof resource === 'string' ? resource : 'not-a-string', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
          approval: headers.get('x-x6-class3-approval') })
        return Promise.resolve(answer())
      }
      const outcome = await approveAndSendOutward(staged, 'https://fixture.invalid', { signal: new AbortController().signal }, fetchImpl)
      return { outcome, sent }
    }
    const binding = await class3Action({ audience: 'https://fixture.invalid', method: 'POST', pathname: '/_host/cloudflare', body: approved })
    const done = await run(() => Response.json({ ok: true, action: 'api', method: 'PATCH', path: dns.path, status: 200, success: true, result: {} }))
    expect(done.outcome).toMatchObject({ kind: 'sent', words: 'Sent.' })
    expect(approvals.map(canonicalJson)).toEqual([canonicalJson(binding)])
    expect(done.sent).toEqual([{ url: '/_host/cloudflare', body: approved, approval: 'stand-in-approval' }])
    const unknown = await run(() => Response.json({ ok: false, code: 'CLOUDFLARE_MUTATION_OUTCOME_UNKNOWN', outcome: 'unknown' }, { status: 503 }))
    expect(unknown.outcome).toEqual({ kind: 'unknown', sent: expect.anything() as unknown,
      words: 'The host answered CLOUDFLARE_MUTATION_OUTCOME_UNKNOWN. It may have gone out: check Cloudflare (read it with a GET) before approving it again.' })
    expect(unknown.sent).toHaveLength(1)
    const lost = await run(() => { throw new Error('reset') })
    expect(lost.outcome).toMatchObject({ kind: 'unknown', words: 'No answer came back (reset). It may have gone out: check Cloudflare (read it with a GET) before approving it again.' })
    expect(lost.sent).toHaveLength(1)
    const refused = await run(() => Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' }, { status: 403 }))
    expect(refused.outcome).toMatchObject({ kind: 'refused', words: 'Not sent: the host refused it (CLASS3_WEBAUTHN_REQUIRED).' })
    expect(outwardMaybeSent(staged)).toBe('It may have gone out: check Cloudflare (read it with a GET) before approving it again.')
    // A GitHub request keeps its own words.
    const github = parseStagedOutward(JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1, tool: 'x6_github', method: 'POST', pathname: '/_host/github',
      body: { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 'T', body: 'B' } } }))!
    expect(outwardMaybeSent(github)).toBe('It may have gone out: check GitHub before approving it again.')
  })
})

// Job 6: the six core families on the owner's card, with the same requests as the edge's end-to-end rows
// (deploy/cloudflare/src/__tests__/cloudflare-door.test.mjs END_TO_END). For each: the sentence shown, and the staged bytes on
// the card are the bytes the (fake) edge receives after approval.
const LIVE = 'f'.repeat(32), OTHER = 'e'.repeat(32)
const LIFECYCLE = { rules: [{ id: 'expire-old', enabled: true, conditions: { prefix: 'tmp/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } } }] }
const CORE: Array<[string, Record<string, unknown>, Record<string, string>, string]> = [
  ['C1 live zone', { action: 'api', method: 'PATCH', path: `/zones/${LIVE}/settings/ssl`, body: { value: 'flexible' } }, { family: 'P1', reason: 'live-zone' },
    'It changes the zone that holds your live home\'s address: its records or its settings.'],
  ['C1 account switch', { action: 'api', method: 'POST', path: '/accounts/{account}/rulesets', body: { kind: 'custom', phase: 'http_request_firewall_custom',
    rules: [{ expression: '(ip.src==192.0.2.1)', action: 'block' }] } }, { family: 'P1', reason: 'account-switch' },
  'It changes a setting that acts on every zone of your Cloudflare account, your live home\'s included.'],
  ['C2 storage', { action: 'api', method: 'PUT', path: '/accounts/{account}/r2/buckets/your-node-archive/lifecycle', body: LIFECYCLE }, { family: 'P1', reason: 'bound-storage' },
    'It can change what your live home stores: its memory and its archive.'],
  ['C3 credentials', { action: 'api', method: 'POST', path: '/accounts/{account}/members', body: { email: 'friend@example.org', roles: ['0123456789abcdef0123456789abcdef'], status: 'pending' } },
    { family: 'P2', reason: 'members' }, 'It changes who can sign in to your Cloudflare account as a member, and with what role.'],
  ['C4 deletion', { action: 'api', method: 'DELETE', path: `/zones/${OTHER}` }, { family: 'P3', reason: 'zone-deletion' },
    'It deletes a whole zone: its address, records and settings. That cannot be undone.'],
  ['C5 charge', { action: 'api', method: 'POST', path: '/accounts/{account}/subscriptions', body: { rate_plan: { id: 'business' }, frequency: 'monthly' } },
    { family: 'P4', reason: 'paid-subscription' }, 'It commits you to a charge: a paid plan for your account, a zone or your user.'],
]
const unspaced = (value: string): string => value.replace(/\s+/gu, '')

describe('each core family on the owner\'s card, and the bytes that leave after his approval', () => {
  for (const [name, request, protection, sentence] of CORE) {
    it(`${name}: the sentence, the exact method, path and body, and those bytes reach the edge`, async () => {
      const staged = parseStagedOutward(file(request, { protection }))!
      expect(staged, name).not.toBeNull()
      const words = outwardWords(staged), rows = new Map(words.rows)
      expect(words.rows[0]).toEqual(['why', sentence])
      expect([rows.get('method'), rows.get('path')]).toEqual([request.method, request.path])
      if (request.body === undefined) expect(rows.has('body')).toBe(false)
      else expect(unspaced(rows.get('body')!)).toBe(canonicalJson(request.body))
      // Nothing on the card reads like advice: it says what the request does, never whether to do it.
      const advice = /\b(?:recommend\w*|should|suggest\w*|worth|cheap\w*|best|save|deal|consider|token)\b/iu
      for (const [, value] of words.rows) expect(value, name).not.toMatch(advice)
      approvals.length = 0
      const received: string[] = []
      const fetchImpl: typeof fetch = async (_resource, init) => {
        received.push(typeof init?.body === 'string' ? init.body : '')
        return Promise.resolve(Response.json({ ok: true, action: 'api', method: request.method, path: request.path, status: 200, success: true, result: { id: 'created' } }))
      }
      const outcome = await approveAndSendOutward(staged, 'https://fixture.invalid', { signal: new AbortController().signal }, fetchImpl)
      expect(outcome).toMatchObject({ kind: 'sent', words: 'Sent.' })
      // The approval binds the staged bytes; the edge receives exactly those bytes, once; the card showed every one of them.
      // The approval binds the staged bytes with the reason he read in them.
      const binding = await class3Action({ audience: 'https://fixture.invalid', method: 'POST', pathname: '/_host/cloudflare',
        body: { ...request, expect: protection } })
      expect(approvals.map(canonicalJson)).toEqual([canonicalJson(binding)])
      expect(received).toHaveLength(1)
      const sent = JSON.parse(received[0]!) as Record<string, unknown>
      expect(canonicalJson(sent)).toBe(staged.canonical)
      expect(staged.canonical).toBe(canonicalJson({ ...request, expect: protection }))
      expect([sent.method, sent.path]).toEqual([rows.get('method'), rows.get('path')])
      if (request.body !== undefined) expect(canonicalJson(sent.body)).toBe(unspaced(rows.get('body')!))
      expect(rows.get('request')).toBe(`POST /_host/cloudflare · ${String(new TextEncoder().encode(staged.canonical).byteLength)} bytes`)
    })
  }
})
