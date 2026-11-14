/** An approved Linear core write from the owner's card, through the real Worker (worker.mjs edgeClass3 and the
 * LINDOOR hooks) to the real door. HEAD is a stand-in that keeps approvals as aumlok.mjs approvalFor does: one approval
 * covers one exact binding (audience, method, pathname, body hash) and is spent once; anything else is refused and spends
 * nothing. Linear is a recorder. Nothing real is called. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { aumlokClass3Binding } from '../aumlok.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { createLinearDoor } from '../linear-door.mjs'
import { createWorker } from '../worker.mjs'

const ORIGIN = 'https://linear-card.example.invalid'
const SEED = 'a'.repeat(64)
const KEY = 'made-up-linear-key-for-the-card-test-0001'
const UUID1 = '11111111-1111-4111-8111-111111111111'
const OWNER = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600, session: 'made-up-session' }
const ENV = { OWNER_EMAIL: 'owner@example.invalid', LINEAR_API_KEY: KEY, LINEAR_DOOR_LEVEL: 'open' }

/** HEAD's approvals (aumlok.mjs approvalFor): issued for one binding, consumed once, never spent by a refusal. */
function head() {
  const issued = new Map()
  const asked = []
  return {
    asked,
    issue: async (token, body) => {
      issued.set(token, { binding: canonicalJson(await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/linear', body })), consumed: false })
    },
    consume: (token, binding) => {
      asked.push({ token, binding })
      const approval = issued.get(token)
      if (!approval || approval.consumed || approval.binding !== canonicalJson(binding)) return { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' }
      approval.consumed = true
      return { ok: true, binding: JSON.parse(approval.binding), expiresAt: Date.now() + 60_000 }
    },
  }
}

function workerFixture(store) {
  const namespace = { idFromName: name => name, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    if (path === '/_head/bootstrap-status') return Response.json({ ok: true, phase: 'complete', seedId: SEED, ballId: 'b'.repeat(64), epoch: 172 })
    if (path === '/_mirror/bootstrap-status') return Response.json({ ok: true, phase: 'ready', seedId: SEED, ballId: 'b'.repeat(64), epoch: 172 })
    if (path === '/_head/class3-authorize') {
      const { token, binding } = await request.json()
      const answer = store.consume(token, binding)
      return Response.json(answer, { status: answer.ok ? 200 : 403 })
    }
    return Response.json({ ok: true, stub: path })
  } }) }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64), HEAD: namespace, MIRROR: namespace, ...ENV }
  const worker = createWorker({ verifyAccess: async () => OWNER })
  return (text, approval) => worker.fetch(new Request(ORIGIN + '/_host/linear', { method: 'POST', body: text,
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(approval ? { 'x-x6-class3-approval': approval } : {}) } }), env)
}

async function withLinear(run) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), ...JSON.parse(init.body) })
    return Response.json({ data: { issueDelete: { success: true }, teamMembershipDelete: { success: true }, projectArchive: { success: true } } })
  }
  try { return await run(calls) } finally { globalThis.fetch = real }
}

const result = async response => {
  const text = await response.text()
  assert.ok(!text.includes(KEY))
  return { status: response.status, body: JSON.parse(text) }
}

test('through the Worker: nothing is sent while held; the approved bytes are sent once; the binding is the one the card signs', async () => {
  await withLinear(async calls => {
    const store = head()
    const post = workerFixture(store)
    const body = { action: 'issue_delete', requestId: 'lincard-worker-0001', id: UUID1 }
    const text = JSON.stringify(body)
    const held = await result(await post(text))
    assert.deepEqual([held.status, held.body.code, held.body.reason], [403, 'CLASS3_WEBAUTHN_REQUIRED', 'delete'])
    assert.equal(calls.length, 0, 'nothing is sent while held')
    await store.issue('made-up-approval-0001', body)
    const sent = await result(await post(text, 'made-up-approval-0001'))
    assert.deepEqual([sent.status, sent.body.ok, sent.body.approved], [200, true, 'delete'])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].variables, { id: UUID1 })
    // The binding HEAD was asked to spend is the card's: class3Action over canonicalJson(body) (class3-approval.ts).
    assert.deepEqual(store.asked.at(-1).binding, await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/linear', body }))
  })
})

test('through the Worker: a body changed after his approval is refused, nothing is sent, and the approval stays his for the bytes he read', async () => {
  await withLinear(async calls => {
    const store = head()
    const post = workerFixture(store)
    const body = { action: 'team_member_remove', requestId: 'lincard-worker-0002', id: 'membership-made-up-1' }
    await store.issue('made-up-approval-0002', body)
    for (const changed of [{ ...body, id: 'membership-made-up-2' }, { ...body, requestId: 'lincard-worker-0002-x' }, { ...body, action: 'project_archive' }]) {
      const refused = await result(await post(JSON.stringify(changed), 'made-up-approval-0002'))
      assert.deepEqual([refused.status, refused.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'], JSON.stringify(changed))
    }
    assert.equal(calls.length, 0, 'no changed body reached Linear')
    const sent = await result(await post(JSON.stringify(body), 'made-up-approval-0002'))
    assert.equal(sent.status, 200)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].variables, { id: 'membership-made-up-1' })
  })
})

test('the same approval a second time is refused at another isolate, and in the same one the first answer comes back: one send', async () => {
  await withLinear(async calls => {
    const store = head()
    const body = { action: 'project_archive', requestId: 'lincard-isolate-0001', id: 'project-made-up-1' }
    await store.issue('made-up-approval-0003', body)
    const door = () => {
      const handle = createLinearDoor({ fetchImpl: globalThis.fetch })
      return approval => handle(new Request(ORIGIN + '/_host/linear', { method: 'POST', body: JSON.stringify(body),
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-x6-class3-approval': approval } }), ENV, {
        access: OWNER,
        authorizeClass3: async input => {
          const answer = store.consume(approval, await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/linear', body: input }))
          if (!answer.ok) throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
          return answer
        },
      })
    }
    const first = door()
    const sent = await result(await first('made-up-approval-0003'))
    assert.deepEqual([sent.status, sent.body.approved], [200, 'archive'])
    const repeat = await result(await first('made-up-approval-0003'))
    assert.deepEqual(repeat.body, { ...sent.body, repeated: true })
    const other = await result(await door()('made-up-approval-0003'))
    assert.deepEqual([other.status, other.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
    assert.equal(calls.length, 1, 'Linear was written once')
  })
})
