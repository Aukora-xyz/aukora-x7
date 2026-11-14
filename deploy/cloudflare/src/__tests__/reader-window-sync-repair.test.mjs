/**
 * reader window regression tests (folding the 793cf616 MUSTs):
 * - RT-SYNC-1: POST /_host/estate (acknowledge_wake / reconcile_proposal / archive_status) from a reader window is refused 403 READER_WINDOW before internal rewrite.
 * - RT-SYNC-2: Lease-changing operations (POST /_mirror/lease, POST /_head/lease acquire/renew/release/reserve-id-promotion, POST /_head/transcript turn_*) and outer write surfaces (vault, message queue, crew-relay, cell-run, web-eyes, bootstrap) are refused 403 READER_WINDOW even when x-x6-class3-approval is present; GET /_head/lease stays open.
 * - RT-SYNC-3: Oversized Cookie headers (> 16 KiB) fail closed on reader-refused routes and ordinary broker/HEAD writes when THREAD_SYNC=on, while keeping sign-in/AUMLOK/reads open and staying inert when THREAD_SYNC is unset.
 * - RT-SYNC-4: Broker & HEAD action classification at each authorization boundary:
 *     (a) Ordinary write actions across /_host/repo, /_host/github, /_host/cloudflare (including CLOUDFLARE_DOOR_LEVEL=open), /_host/linear (including LINEAR_DOOR_LEVEL=open), /_host/archive (export without includeBundle & rebuild_drill), /_head/transcript, and /_head/ball (T1 organ replacement) remain refused 403 READER_WINDOW even when x-x6-class3-approval is spoofed.
 *     (b) Legitimate POST reads on /_host/repo, /_host/github, /_host/cloudflare, /_host/linear, and /_host/archive pass without any approval header.
 *     (c) Genuine Class-3 actions carrying a spoofed x-x6-class3-approval header reach cryptographic Class-3 verification and fail 403 CLASS3_WEBAUTHN_REQUIRED without dispatching or mutating state.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createWorker } from '../worker.mjs'
import { READER_WINDOW_COOKIE, READER_WINDOW_SENTENCE } from '../reader-window.mjs'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest } from '../head-do.mjs'

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname
const ORIGIN = 'https://reader-sync-repair.example.org'
const SEED = 'a'.repeat(64)
const BALL = 'b'.repeat(64)
const MARK = `${READER_WINDOW_COOKIE}=reader`
const SPOOFED_APPROVAL = { 'x-x6-class3-approval': 'spoofed-unverified-token' }
const sha256 = text => createHash('sha256').update(text).digest('hex')
const FROZEN_FIXTURE = REPO_ROOT + 'packages/experimental/webworker-runtime/tests/x6/fixtures/frozen-head/'
const FROZEN_HEAD = JSON.parse(readFileSync(FROZEN_FIXTURE + 'HEAD.json', 'utf8'))
const readModuleCode = sha => {
  const frozen = `${FROZEN_FIXTURE}balls/${sha}.js`
  return readFileSync(existsSync(frozen) ? frozen : `${REPO_ROOT}mirror/home/balls/${sha}.js`, 'utf8')
}

function workerFixture(extraEnv = {}, { networkFetch: customNetworkFetch } = {}) {
  const reached = []
  const upstreamCalls = []
  const namespace = {
    idFromName: name => name,
    get: () => ({
      fetch: async request => {
        const path = new URL(request.url).pathname
        reached.push(`${request.method} ${path}`)
        if (path === '/_head/bootstrap-status') return Response.json({ ok: true, phase: 'complete', seedId: SEED, ballId: BALL,
          epoch: 172 })
        if (path === '/_mirror/bootstrap-status') return Response.json({ ok: true, phase: 'ready', seedId: SEED, ballId: BALL, epoch: 172 })
        if (path === '/_head/class3-authorize') return Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' }, { status: 403 })
        if (path === '/_head/repo-proposal') return Response.json({ ok: true, stagedRepoProposal: null, repoMergeAttempt: null, lastRepoMergeOutcome: null })
        if (path === '/_head/archive-summary') {
          return Response.json({
            ok: true,
            seedId: SEED,
            headJsonBytes: 512,
            head: { ballId: BALL, epoch: 172, parentBallId: '0'.repeat(64), version: 'x6.1-ball/v1', entries: {}, modules: {} },
            moduleInventory: [],
            ownerSummary: { phase: 'bound', ownerPublicKeyHex: 'e'.repeat(64), credentialId: 'cred-1', signerCounter: 1 },
          })
        }
        if (path === '/_mirror/archive-plan') {
          return Response.json({
            ok: true,
            mirrorJsonBytes: 512,
            totals: { entries: 1, files: 1, bodyB64Bytes: 32, largestFileB64: 32 },
            receiptsSummary: { receiptCount: 1, merkleRoot: 'c'.repeat(64), checkpointCount: 0, lastLeafHash: 'c'.repeat(64) },
          })
        }
        return Response.json({ ok: true, stub: path })
      },
    }),
  }
  const defaultNetworkFetch = async (url, init = {}) => {
    const href = typeof url === 'string' ? url : url.url
    upstreamCalls.push({ method: init.method ?? 'GET', url: href })
    if (customNetworkFetch) return await customNetworkFetch(href, init)
    if (href === 'https://api.linear.app/graphql') {
      const gqlBody = init.body ? JSON.parse(init.body) : {}
      if (/LinearDoorIssueId/.test(gqlBody.query ?? '')) {
        return Response.json({ data: { issue: { id: '11111111-1111-4111-8111-111111111111' } } })
      }
      return Response.json({ data: { viewer: { id: 'usr-1', name: 'Auma', email: 'auma@example.invalid' }, organization: { id: 'org-1', name: 'Aukora', urlKey: 'aukora' } } })
    }
    if (href.startsWith('https://api.cloudflare.com/client/v4/')) {
      if (href.includes('/workers/scripts/') && href.endsWith('/settings')) {
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            bindings: [
              { type: 'durable_object_namespace', name: 'HEAD', class_name: 'X61HeadDurableObject' },
              { type: 'durable_object_namespace', name: 'MIRROR', class_name: 'MirrorDO' },
            ],
            tail_consumers: [],
          },
        })
      }
      if (href.includes('/workers/durable_objects/namespaces')) {
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result_info: { page: 1, per_page: 1000, count: 3, total_count: 3, total_pages: 1 },
          result: [
            { id: '5ead0000000000000000000000000a01', name: 'your-node_X61HeadDurableObject', script: 'your-node', class: 'X61HeadDurableObject', use_sqlite: true },
            { id: '5ead0000000000000000000000000a02', name: 'your-node_MirrorDO', script: 'your-node', class: 'MirrorDO', use_sqlite: true },
            { id: '5ead0000000000000000000000000a04', name: 'your-node_VoiceBridgeDO', script: 'your-node', class: 'VoiceBridgeDO', use_sqlite: true },
          ],
        })
      }
      if (href.includes('/zones?')) {
        const zoneName = new URL(href).searchParams.get('name') ?? 'example.invalid'
        return Response.json({ success: true, errors: [], messages: [], result: [{ id: '2'.repeat(32), name: zoneName }], result_info: { page: 1, count: 1 } })
      }
      return Response.json({ success: true, result: [], errors: [], messages: [], result_info: { page: 1, count: 0 } })
    }
    if (href.startsWith('https://api.github.com/')) {
      if (href.includes('/commits?')) {
        return Response.json([{ sha: '1'.repeat(40), commit: { message: 'head commit' }, parents: [] }])
      }
      return Response.json({ full_name: 'your_org_x/your-node', default_branch: 'main', private: true, html_url: 'https://github.com/your_org_x/your-node' })
    }
    return Response.json({ ok: true })
  }
  const env = {
    THREAD_SYNC: 'on',
    PUBLIC_HOST: new URL(ORIGIN).host,
    OWNER_EMAIL: 'owner@example.invalid',
    OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64),
    GITHUB_TOKEN: 'ghs_test_token_value_1234567890',
    CLOUDFLARE_API_TOKEN: 'cf_test_token_value_1234567890',
    CLOUDFLARE_ACCOUNT_ID: '1'.repeat(32),
    LINEAR_API_KEY: 'lin_api_test_token_1234567890',
    HEAD: namespace,
    MIRROR: namespace,
    ...extraEnv,
  }
  const worker = createWorker({
    verifyAccess: async () => ({ type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }),
    networkFetch: defaultNetworkFetch,
  })
  const call = async (path, { method = 'POST', cookie = MARK, body = {}, headers = {} } = {}) => {
    const realFetch = globalThis.fetch
    globalThis.fetch = defaultNetworkFetch
    try {
      return await worker.fetch(new Request(ORIGIN + path, {
        method,
        headers: {
          origin: ORIGIN,
          'sec-fetch-site': 'same-origin',
          ...(method === 'GET' || method === 'HEAD' ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }), env)
    } finally {
      globalThis.fetch = realFetch
    }
  }
  return { call, reached, upstreamCalls }
}

function storageFixture() {
  let data = new Map()
  let tail = Promise.resolve()
  const view = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map(
      [...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([k, v]) => [k, structuredClone(v)]),
    ),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(
    ['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]),
  )
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const copy = structuredClone(data)
      const out = await operation(view(copy))
      data = copy
      return out
    })
    tail = result.catch(() => {})
    return result
  }
  return storage
}

async function realHeadFixture() {
  const organId = 'auma-cortex'
  const genesisBall = FROZEN_HEAD
  const env = {
    THREAD_SYNC: 'on',
    PUBLIC_HOST: new URL(ORIGIN).host,
    OWNER_PUBLIC_KEY_HEX: '11'.repeat(32),
    OWNER_EMAIL: 'owner@example.invalid',
    AUMLOK_CUSTODY_PEPPER: '22'.repeat(32),
  }
  const head = new X61HeadDurableObject({ storage: storageFixture(), getWebSockets: () => [] }, env)
  const codeBySha = Object.fromEntries(Object.keys(genesisBall.modules).map(sha => [sha, readModuleCode(sha)]))
  const payload = { version: BOOTSTRAP_VERSION, ball: genesisBall, codeBySha, mirror: { entryCount: 0, batchDigests: [] } }
  const seedId = await digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: genesisBall.ballId, epoch: genesisBall.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)

  const prevEntry = genesisBall.entries[organId]
  const before = readModuleCode(prevEntry.specifier.slice(5))
  const src1 = before.replace(/name:\s*'auma_cortex'/, "name: 'auma-cortex'") + '\n// reader-sync-repair test\n'
  const sha1 = sha256(src1)
  const specifier1 = `ball:${sha1}`
  const nextEntry = {
    id: organId,
    specifier: specifier1,
    config: JSON.parse(JSON.stringify(prevEntry.config ?? {})),
    disabled: prevEntry.disabled ?? false,
    ...(prevEntry.governance === undefined ? {} : { governance: prevEntry.governance }),
    previousSpecifiers: [...prevEntry.previousSpecifiers, prevEntry.specifier],
    previousVersions: [...(prevEntry.previousVersions ?? []), { specifier: prevEntry.specifier, config: JSON.parse(JSON.stringify(prevEntry.config)), disabled: prevEntry.disabled }],
    updatedAt: Date.now(),
  }
  const nextBody = {
    version: 'x6.1-ball/v1',
    parentBallId: genesisBall.ballId,
    epoch: genesisBall.epoch + 1,
    createdAt: Date.now(),
    authorPeerId: 'writer-peer',
    entries: { ...genesisBall.entries, [organId]: nextEntry },
    modules: {
      ...genesisBall.modules,
      [sha1]: { sha256: sha1, specifier: specifier1, name: organId, description: `Cordis ball plugin ${organId}`, size: Buffer.byteLength(src1), createdAt: Date.now() },
    },
  }
  const nextBall = { ...nextBody, ballId: sha256(canonicalBootstrap(nextBody)) }

  const headCall = async (path, body, { cookie = MARK, headers = {} } = {}) => {
    const res = await head.fetch(new Request(ORIGIN + path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'x-x6-internal-authorized': '1',
        'x-x6-bootstrap-seed': seedId,
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-x6-verified-access': JSON.stringify({ type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
    }))
    return { status: res.status, body: await res.json() }
  }
  return { head, headCall, genesisBall, nextBall, nextCodeBySha: { [sha1]: src1 }, organId, sha1 }
}

const assertReaderRefused = async (res, label) => {
  assert.equal(res.status, 403, label)
  assert.deepEqual(await res.json(), { ok: false, code: 'READER_WINDOW', message: READER_WINDOW_SENTENCE }, label)
}

test('RT-SYNC-1: POST /_host/estate from a reader-marked browser is refused 403 READER_WINDOW even with spoofed approval header', async () => {
  const f = workerFixture()
  for (const headers of [{}, SPOOFED_APPROVAL]) {
    for (const body of [
      { action: 'acknowledge_wake', wakeId: `wake-${SEED}-1` },
      { action: 'reconcile_proposal' },
      { action: 'archive_status' },
    ]) {
      await assertReaderRefused(await f.call('/_host/estate', { body, headers }), `POST /_host/estate ${body.action}`)
    }
  }
  assert.deepEqual(f.reached, [])

  const getEstate = await f.call('/_host/estate', { method: 'GET' })
  assert.notEqual((await getEstate.clone().json().catch(() => ({}))).code, 'READER_WINDOW')
})

test('RT-SYNC-2: lease-changing operations (/_mirror/lease, /_head/lease) and outer write surfaces are refused 403 READER_WINDOW even with spoofed approval', async () => {
  const f = workerFixture()
  const writeAttempts = [
    ['/_mirror/lease', 'POST', { action: 'acquire', clientId: '00000000-0000-4000-8000-000000000001', tabId: 'tab-1', label: 'Reader' }],
    ['/_mirror/lease', 'POST', { action: 'take', clientId: '00000000-0000-4000-8000-000000000001', tabId: 'tab-1', label: 'Reader' }],
    ['/_head/lease', 'POST', { action: 'acquire', ownerPeerId: 'reader-peer', ttlMs: 30000 }],
    ['/_head/lease', 'POST', { action: 'renew', ownerPeerId: 'reader-peer', generation: 1, ttlMs: 30000 }],
    ['/_head/lease', 'POST', { action: 'release', ownerPeerId: 'reader-peer', generation: 1 }],
    ['/_head/lease', 'POST', { action: 'reserve-id-promotion', ownerPeerId: 'reader-peer', generation: 1 }],
    ['/_vault/blob/' + 'c'.repeat(64), 'PUT', 'payload'],
    ['/_vault/index/' + 'd'.repeat(64), 'PUT', '{}'],
    ['/aukora-messages/send', 'POST', { to: 'peer', text: 'hi' }],
    ['/aukora-messages/add-contact', 'POST', { id: 'peer' }],
    ['/aukora-messages/thread', 'POST', { id: 'peer' }],
    ['/_host/crew-relay', 'POST', { text: 'from reader window' }],
    ['/_host/cell-run', 'POST', { cell: 'cord-echo' }],
    ['/_host/web-eyes', 'POST', { action: 'search', query: 'test' }],
    ['/_bootstrap', 'POST', {}],
  ]
  for (const headers of [{}, SPOOFED_APPROVAL]) {
    for (const [path, method, body] of writeAttempts) {
      await assertReaderRefused(await f.call(path, { method, body, headers }), `${method} ${path}`)
    }
  }
  assert.deepEqual(f.reached, [])

  const getHeadLease = await f.call('/_head/lease', { method: 'GET' })
  assert.notEqual((await getHeadLease.clone().json().catch(() => ({}))).code, 'READER_WINDOW')
})

test('RT-SYNC-3: oversized Cookie headers (> 16 KiB) fail closed on reader-refused routes and ordinary broker writes when THREAD_SYNC=on', async () => {
  const stuffedCookie = `${('pad=' + 'x'.repeat(250) + '; ').repeat(68)}${MARK}`
  assert.ok(stuffedCookie.length > 16384)

  const f = workerFixture()
  for (const [path, method, body, headers] of [
    ['/_host/wake', 'POST', { action: 'trigger' }, {}],
    ['/_head/lease', 'POST', { action: 'acquire', ownerPeerId: 'p' }, SPOOFED_APPROVAL],
    ['/_mirror/delta', 'POST', {}, {}],
    ['/_host/repo', 'POST', { action: 'branch_create', branch: 'auma/sandbox/probe', baseSha: '1'.repeat(40) }, SPOOFED_APPROVAL],
    ['/door/deepseek/chat/completions', 'POST', {}, {}],
    ['/_head/promotion-status', 'GET', undefined, {}],
  ]) {
    await assertReaderRefused(await f.call(path, { method, cookie: stuffedCookie, body, headers }), `${method} ${path}`)
  }

  for (const [path, method] of [['/_host/aumlok/approve', 'POST'], ['/_head/promote', 'POST'], ['/_head/ball', 'GET'], ['/_head/lease', 'GET']]) {
    const res = await f.call(path, { method, cookie: stuffedCookie, body: {} })
    assert.notEqual((await res.clone().json().catch(() => ({}))).code, 'READER_WINDOW', `${method} ${path}`)
  }

  const off = workerFixture({ THREAD_SYNC: undefined })
  const resOff = await off.call('/_host/wake', { cookie: stuffedCookie, body: { action: 'trigger' } })
  assert.notEqual((await resOff.clone().json().catch(() => ({}))).code, 'READER_WINDOW')
  assert.equal(off.reached.includes('POST /_host/wake'), true)
})

test('RT-SYNC-4a: spoofed x-x6-class3-approval never opens ordinary broker writes across repo, github, cloudflare, linear, and archive', async () => {
  const f = workerFixture({ CLOUDFLARE_DOOR_LEVEL: 'open', LINEAR_DOOR_LEVEL: 'open' })
  const ordinaryBrokerWrites = [
    ['/_host/repo', { action: 'branch_create', branch: 'auma/sandbox/reader', baseSha: '1'.repeat(40) }],
    ['/_host/repo', { action: 'branch_delete', branch: 'auma/sandbox/reader', expectedHeadSha: '1'.repeat(40) }],
    ['/_host/repo', { action: 'commit', branch: 'auma/sandbox/reader', expectedHeadSha: '1'.repeat(40), message: 'x', changes: [{ path: 'docs/auma/note.md', content: 'hi\n' }] }],
    ['/_host/repo', { action: 'apply_patch', branch: 'auma/sandbox/reader', expectedHeadSha: '1'.repeat(40), message: 'x', patch: '--- a/docs/auma/note.md\n+++ b/docs/auma/note.md\n' }],
    ['/_host/repo', { action: 'write', path: 'docs/auma/note.md', content: 'hi\n' }],
    ['/_host/repo', { action: 'edit', path: 'docs/auma/note.md', oldString: 'a', newString: 'b' }],
    ['/_host/repo', { action: 'commit', message: 't1 owner write', changes: [{ path: 'docs/auma/note.md', content: 'hi\n' }] }],
    ['/_host/repo', { action: 'stage_proposal', branch: 'auma/proposal/reader', baseSha: '1'.repeat(40), headSha: '2'.repeat(40), treeSha: '3'.repeat(40), title: 't', summary: 's' }],
    ['/_host/repo', { action: 'reconcile_proposal' }],
    ['/_host/repo', { action: 'release_attempt', attemptId: '00000000-0000-4000-8000-000000000001' }],
    ['/_host/repo', { action: 'dispatch_workflow', workflow: 'deploy-x61.yml' }],
    ['/_host/repo', { action: 'dispatch_workflow', workflow: 'auma-exec.yml', inputs: { command: 'npm test', timeout_minutes: '5', label: 'check' } }],
    ['/_host/repo', { action: 'exec_cancel', runId: 12345 }],
    ['/_host/repo', { action: 'sync_head_to_github' }],
    ['/_host/cloudflare', { action: 'api', method: 'POST', path: `/accounts/${'1'.repeat(32)}/storage/kv/namespaces`, body: { title: 'reader-kv' } }],
    ['/_host/linear', { action: 'comment', issue: 'YOURTEAM-271', body: 'reader comment', requestId: 'reader-req-00000001' }],
    ['/_host/archive', { action: 'export' }],
    ['/_host/archive', { action: 'export', includeBundle: false }],
    ['/_host/archive', { action: 'rebuild_drill' }],
  ]
  for (const [path, body] of ordinaryBrokerWrites) {
    await assertReaderRefused(await f.call(path, { body }), `unapproved POST ${path} ${body.action}`)
  }
  assert.deepEqual(f.upstreamCalls, [], 'zero upstream calls were made for unapproved reader writes')
  for (const [path, body] of ordinaryBrokerWrites) {
    await assertReaderRefused(await f.call(path, { body, headers: SPOOFED_APPROVAL }), `spoofed-approval POST ${path} ${body.action}`)
  }
  assert.equal(f.upstreamCalls.every(c => c.method === 'GET'), true, 'zero upstream write calls were made even under spoofed approval header')
})

test('RT-SYNC-4b: legitimate POST reads on repo, github, cloudflare, linear, and archive pass without an approval header; genuine Class-3 actions require verified Class 3', async () => {
  const f = workerFixture({ LINEAR_DOOR_LEVEL: 'guarded' })
  for (const [path, body] of [
    ['/_host/repo', { action: 'log', limit: 1 }],
    ['/_host/github', { action: 'status' }],
    ['/_host/github', { action: 'api', method: 'GET', endpoint: '/repos/your_org_x/your-node' }],
    ['/_host/cloudflare', { action: 'status' }],
    ['/_host/cloudflare', { action: 'api', method: 'GET', path: `/accounts/${'1'.repeat(32)}/storage/kv/namespaces` }],
    ['/_host/linear', { action: 'status' }],
    ['/_host/archive', { action: 'status' }],
  ]) {
    const res = await f.call(path, { body })
    const payload = await res.json()
    assert.notEqual(payload.code, 'READER_WINDOW', `read POST ${path} ${body.action}`)
    assert.equal(res.status, 200, `read POST ${path} ${body.action}: ${JSON.stringify(payload)}`)
  }

  // Genuine Class-3 writes without an approval header fail READER_WINDOW; with a spoofed header they fail CLASS3_WEBAUTHN_REQUIRED before dispatching.
  const class3Writes = [
    ['/_host/github', { action: 'api', method: 'POST', endpoint: '/repos/your_org_x/your-node/issues', body: { title: 'Test', body: 'Body' } }],
    ['/_host/repo', { action: 'commit', branch: 'main', expectedHeadSha: '1'.repeat(40), idempotencyKey: 'idem-key-1234567890', message: 'publish', changes: [{ path: 'docs/auma/note.md', content: 'hi\n' }] }],
    ['/_host/linear', { action: 'comment', issue: '11111111-1111-4111-8111-111111111111', body: 'guarded comment', requestId: 'reader-guarded-0001' }],
    ['/_host/archive', { action: 'export', includeBundle: true }],
  ]
  const upstreamBefore = f.upstreamCalls.length
  for (const [path, body] of class3Writes) {
    await assertReaderRefused(await f.call(path, { body }), `unapproved Class-3 POST ${path}`)
    const spoofed = await f.call(path, { body, headers: SPOOFED_APPROVAL })
    assert.equal(spoofed.status, 403, `spoofed Class-3 POST ${path}`)
    assert.equal((await spoofed.json()).code, 'CLASS3_WEBAUTHN_REQUIRED', `spoofed Class-3 POST ${path}`)
  }
  assert.equal(f.upstreamCalls.length, upstreamBefore, 'zero upstream writes dispatched under spoofed Class-3 header')
})

test('RT-SYNC-4c: real X61HeadDurableObject refuses spoofed-approval transcript mutations, lease ops, and T1 organ updates from a reader window', async () => {
  const fx = await realHeadFixture()

  // Writer browser (no reader mark) acquires a valid writer lease and reserves id-promotion.
  const lease = await fx.headCall('/_head/lease', { action: 'acquire', ownerPeerId: 'writer-peer', ttlMs: 30000 }, { cookie: '' })
  assert.equal(lease.status, 200)
  const reserved = await fx.headCall('/_head/lease', {
    action: 'reserve-id-promotion',
    ownerPeerId: 'writer-peer',
    generation: lease.body.lease.generation,
    expectedBallId: fx.genesisBall.ballId,
    organId: fx.organId,
    candidateSha: fx.sha1,
  }, { cookie: '' })
  assert.equal(reserved.status, 200)

  // Reader window with spoofed Class-3 header cannot touch /_head/lease, /_head/transcript ordinary actions, or T1 /_head/ball publish.
  const leaseAttempt = await fx.headCall('/_head/lease', { action: 'release', ownerPeerId: 'writer-peer', generation: lease.body.lease.generation }, { headers: SPOOFED_APPROVAL })
  assert.equal(leaseAttempt.status, 403)
  assert.equal(leaseAttempt.body.code, 'READER_WINDOW')

  for (const body of [
    { action: 'turn_start', turn_id: 'turn-1', tab_id: 'reader-tab' },
    { action: 'append', role: 'user', content: 'spoofed' },
    { action: 'wish_create', intent: 'spoofed wish' },
    { action: 'wish_step' },
    { action: 'wish_stop' },
    { action: 'read' },
  ]) {
    const out = await fx.headCall('/_head/transcript', body, { headers: SPOOFED_APPROVAL })
    assert.equal(out.status, 403, `transcript ${body.action}`)
    assert.equal(out.body.code, 'READER_WINDOW', `transcript ${body.action}`)
  }

  // Even carrying the active writerLease + spoofed Class-3 header, a reader window's T1 organ replacement on POST /_head/ball is refused 403 READER_WINDOW.
  const t1Publish = await fx.headCall('/_head/ball', {
    type: 'ball:commit',
    fromPeerId: 'writer-peer',
    ball: fx.nextBall,
    codeBySha: fx.nextCodeBySha,
    expectedParentBallId: fx.genesisBall.ballId,
    expectedEpoch: fx.genesisBall.epoch,
    writerLease: lease.body.lease,
  }, { headers: SPOOFED_APPROVAL })
  assert.equal(t1Publish.status, 403)
  assert.deepEqual(t1Publish.body, { ok: false, code: 'READER_WINDOW', message: READER_WINDOW_SENTENCE })
  assert.equal((await fx.head.store.read()).ball.epoch, fx.genesisBall.epoch, 'HEAD epoch stayed untouched')

  // Control: the unmarked writer publishes the exact same T1 organ replacement cleanly to epoch + 1.
  const writerPublish = await fx.headCall('/_head/ball', {
    type: 'ball:commit',
    fromPeerId: 'writer-peer',
    ball: fx.nextBall,
    codeBySha: fx.nextCodeBySha,
    expectedParentBallId: fx.genesisBall.ballId,
    expectedEpoch: fx.genesisBall.epoch,
    writerLease: lease.body.lease,
  }, { cookie: '' })
  assert.equal(writerPublish.status, 200, JSON.stringify(writerPublish.body))
  assert.equal((await fx.head.store.read()).ball.epoch, fx.genesisBall.epoch + 1)
})
