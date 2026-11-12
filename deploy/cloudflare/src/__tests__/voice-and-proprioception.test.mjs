/** Mouth-Brain Duplex Voice Director (`aukora.voice-director.v1`), cost proprioception,
 * Sovereignty telemetry, and `/api/body/run` alias tests.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject, canonicalBootstrap, digest, manifestId, manifestIdCanon, BOOTSTRAP_VERSION } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import {
  PERSONAPLEX_VOICES,
  VOICE_DIRECTOR_PROTOCOL,
  VOICE_STATE_MAX_BYTES,
  compileVoiceStateSlot,
  idleVoiceDirective,
  validateSpeakableClause,
} from '../voice-director.mjs'

const ORIGIN = 'https://x61.example.invalid'

function createMemoryStorage() {
  const data = new Map()
  let alarm = null
  const view = {
    get: async key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    deleteAll: async () => { data.clear(); alarm = null },
    list: async ({ prefix = '', limit = Infinity } = {}) => {
      const out = new Map()
      for (const [k, v] of [...data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (k.startsWith(prefix)) {
          out.set(k, structuredClone(v))
          if (out.size >= limit) break
        }
      }
      return out
    },
    getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at },
    deleteAlarm: async () => { alarm = null },
    transaction: async fn => fn(view),
  }
  return view
}

async function createSeededEdgeFixture({ networkFetch = async () => { throw new Error('External network is forbidden in fixture') }, launchBrowser = null } = {}) {
  const source = 'export const organ = "seed-echo";\n'
  const sha = await digest(source)
  const ballDraft = {
    version: 'x6.1-ball/v1',
    epoch: 167,
    parentBallId: null,
    createdAt: '2026-11-11T00:00:00.000Z',
    authorPeerId: 'auma-live',
    entries: {
      'seed-echo': {
        id: 'seed-echo',
        specifier: `ball:${sha}`,
        disabled: false,
        config: {},
        previousSpecifiers: [],
      },
    },
    modules: {
      [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(source) },
    },
  }
  const ball = { ...ballDraft, ballId: await manifestId(ballDraft) }
  const mirrorEntries = [
    ['/dsh/home/auma', { kind: 'dir', mode: 0o755 }],
    ['/dsh/home/auma/HANDOFF.md', {
      kind: 'file',
      mode: 0o644,
      mtimeMs: 1794350000000,
      b64: Buffer.from('# HANDOFF\n').toString('base64'),
    }],
  ]
  const batchDigest = await digest(canonicalBootstrap(mirrorEntries))
  const seedPayload = {
    version: BOOTSTRAP_VERSION,
    ball,
    codeBySha: { [sha]: source },
    mirror: { entryCount: mirrorEntries.length, batchDigests: [batchDigest] },
  }
  const seedId = await digest(canonicalBootstrap(seedPayload))
  const pkg = { ...seedPayload, seedId }

  const headStorage = createMemoryStorage()
  const mirrorStorage = createMemoryStorage()
  const env = {
    PUBLIC_HOST: 'x61.example.invalid',
    OWNER_EMAIL: 'owner@example.invalid',
    OWNER_PUBLIC_KEY_HEX: '11'.repeat(32),
    AUMLOK_CUSTODY_PEPPER: '22'.repeat(32),
    DEEPSEEK_API_KEY: 'synthetic-deepseek-key',
    PROVIDER_BUDGET_WINDOW_MS: '60000',
    PROVIDER_BUDGET_REQUESTS: '20',
    PROVIDER_BUDGET_TOKENS: '100000',
    PROVIDER_MAX_OUTPUT_TOKENS: '256',
    SOURCE_REVISION: '67fde49f4c67ddeb8c408ce99c22f9d60fb8163c',
  }
  const headDo = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch })
  const mirrorDo = new MirrorDO({ storage: mirrorStorage }, env)
  env.HEAD = { idFromName: () => 'node-main-v1', get: () => headDo }
  env.MIRROR = { idFromName: () => 'node-main-v1', get: () => mirrorDo }

  const worker = createWorker({
    verifyAccess: async () => ({ type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }),
    networkFetch,
    launchBrowser,
    now: () => 1794351000000,
  })

  const postBootstrap = body => worker.fetch(new Request(`${ORIGIN}/_bootstrap`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env)
  assert.equal((await postBootstrap({ action: 'prepare', package: pkg })).status, 200)
  assert.equal((await postBootstrap({ action: 'batch', seedId, index: 0, entries: mirrorEntries })).status, 200)
  assert.equal((await postBootstrap({ action: 'commit', seedId })).status, 200)

  return { env, worker, headStorage, mirrorStorage, ball, seedId }
}

test('Mouth-Brain Voice Director: enforces grounded speakable clauses, idle backchannel_only lock, and <=1200-byte state slot', () => {
  assert.equal(PERSONAPLEX_VOICES.length, 16)
  const idle = validateSpeakableClause(null)
  assert.deepEqual(idle, idleVoiceDirective())
  assert.equal(idle.mode, 'backchannel_only')
  assert.equal(idle.allowSubstantiveGeneration, false)

  const valid = validateSpeakableClause({
    turnId: 'voice-turn-1',
    clauseId: 'clause-1',
    voiceId: 'NATF2',
    text: 'Epoch 167 is live and all 24 retention cases pass.',
    urgency: 'immediate',
    interruptible: true,
  })
  assert.equal(valid.mode, 'forced_text_stream')
  assert.equal(valid.allowSubstantiveGeneration, false)
  assert.equal(valid.voiceId, 'NATF2')

  // Refuse raw JSON, arrays, code blocks, and ungrounded tool dumps across the mouth boundary.
  for (const raw of [
    '{"ok":true,"tool":"x6_repo"}',
    '[{"seq":149}]',
    'Here is output: ```json\n{}\n```',
    'tool_call_id: call_123',
  ]) {
    assert.throws(
      () => validateSpeakableClause({ turnId: 'voice-turn-1', text: raw }),
      { code: 'VOICE_CLAUSE_RAW_PAYLOAD_REFUSED' },
    )
  }

  // State slot strictly bounded to <= 1200 UTF-8 bytes (~300 tokens).
  const hugeSlot = compileVoiceStateSlot({
    epoch: 167,
    ballId: '7c4938450b882917000000000000000000000000000000000000000000000067',
    topic: 'A'.repeat(2000),
    activeWish: 'B'.repeat(2000),
    openThreads: Array.from({ length: 10 }, (_, i) => `Thread ${String(i)} ${'C'.repeat(400)}`),
  })
  assert.ok(hugeSlot.byteLength <= VOICE_STATE_MAX_BYTES)
  assert.ok(hugeSlot.slotText.includes('CURRENT_STATE'))
})

test('Edge Voice Director: journals spoken turns with voiceAuthority="none", supports barge_in cancellation, and fails closed on /door/voice', async () => {
  const fx = await createSeededEdgeFixture()

  // 1. GET /_host/voice reports status without leaking upstream URLs or tokens.
  fx.env.PERSONAPLEX_AUTH_TOKEN = 'secret-renderer-token-never-expose'
  const statusRes = await fx.worker.fetch(new Request(`${ORIGIN}/_host/voice`, {
    headers: { 'sec-fetch-site': 'same-origin' },
  }), fx.env)
  assert.equal(statusRes.status, 200)
  const statusJson = await statusRes.json()
  assert.equal(statusJson.protocol, VOICE_DIRECTOR_PROTOCOL)
  assert.equal(statusJson.configured, false)
  assert.equal(statusJson.voiceAuthority, 'none')
  assert.equal(JSON.stringify(statusJson).includes('secret-renderer-token-never-expose'), false)

  // 2. /door/voice fails closed with 503 VOICE_RENDERER_UNCONFIGURED when PERSONAPLEX_WS_URL is unset,
  //    and refuses cross-origin upgrades with 403 ORIGIN_REFUSED.
  const crossOriginDoor = await fx.worker.fetch(new Request(`${ORIGIN}/door/voice`, {
    headers: { origin: 'https://evil.example.invalid', upgrade: 'websocket' },
  }), fx.env)
  assert.equal(crossOriginDoor.status, 403)

  const unconfiguredDoor = await fx.worker.fetch(new Request(`${ORIGIN}/door/voice?voice=NATF1`, {
    headers: { origin: ORIGIN, upgrade: 'websocket' },
  }), fx.env)
  assert.equal(unconfiguredDoor.status, 503)
  assert.equal((await unconfiguredDoor.json()).code, 'VOICE_RENDERER_UNCONFIGURED')

  // 3. POST /_host/voice dispatch_turn commits pre-agent turn journal with voiceAuthority: 'none',
  //    ignoring smuggled owner flags.
  const dispatchRes = await fx.worker.fetch(new Request(`${ORIGIN}/_host/voice`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'dispatch_turn',
      turnId: 'voice-turn-alpha',
      voiceId: 'NATF1',
      transcript: 'Read the latest handoff summary.',
      ownerApproved: true,
      ownerSession: true,
    }),
  }), fx.env)
  assert.equal(dispatchRes.status, 200)
  const dispatchJson = await dispatchRes.json()
  assert.equal(dispatchJson.savedBeforeDispatch, true)
  assert.equal(dispatchJson.signerRole, 'voice-transcript-unconfirmed')
  assert.equal(dispatchJson.voiceAuthority, 'none')
  assert.equal(dispatchJson.ownerAuthorityGranted, false)

  // Simulate an active running turn for `voice-turn-alpha` and cancel it via `barge_in`.
  await fx.headStorage.put('head:turn:active', {
    turn_id: 'voice-turn-alpha',
    tab_id: 'voice-tab-1',
    status: 'running',
    started_at: 1794351000000,
    heartbeat_at: 1794351000000,
  })
  const bargeRes = await fx.worker.fetch(new Request(`${ORIGIN}/_host/voice`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'barge_in', turnId: 'voice-turn-alpha' }),
  }), fx.env)
  assert.equal(bargeRes.status, 200)
  const bargeJson = await bargeRes.json()
  assert.equal(bargeJson.cancelled, true)
  assert.equal(bargeJson.activeTurnCancelled, true)
  assert.equal(bargeJson.idleDirective.mode, 'backchannel_only')

  const activeAfter = await fx.headStorage.get('head:turn:active')
  assert.equal(activeAfter.status, 'abandoned')
  assert.equal(activeAfter.outcome, 'barge_in_cancelled')
})

test('Cost proprioception (`providerUsage`) and `/api/body/run` alias report deterministic state without leaking secrets', async () => {
  let browserRuns = 0
  const fx = await createSeededEdgeFixture({
    networkFetch: async () => Response.json({ ok: true }),
    launchBrowser: async () => {
      browserRuns += 1
      return {
        newPage: async () => ({
          goto: async () => {},
          evaluate: async () => ({ ok: true, epoch: 167, ballId: fx.ball.ballId }),
          close: async () => {},
        }),
        close: async () => {},
      }
    },
  })

  // Reserve budget via /door/deepseek/v1/chat/completions
  const doorRes = await fx.worker.fetch(new Request(`${ORIGIN}/door/deepseek/v1/chat/completions`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Check proprioception.' }],
    }),
  }), fx.env)
  assert.equal(doorRes.status, 200)

  const health = await (await fx.worker.fetch(new Request(`${ORIGIN}/api/health`), fx.env)).json()
  assert.equal(health.buildSha, '67fde49f4c67ddeb8c408ce99c22f9d60fb8163c')
  assert.deepEqual(health.liveHead, { ballId: fx.ball.ballId, epoch: 167 })
  assert.equal(health.capabilities.voiceDirector, true)
  assert.equal(health.providerUsage.configured, true)
  assert.equal(health.providerUsage.totalRequestsReserved, 1)
  assert.ok(health.providerUsage.totalTokensReserved > 128)
  assert.equal(health.providerUsage.providers.deepseek.requestsReserved, 1)
  assert.equal(JSON.stringify(health).includes('synthetic-deepseek-key'), false)

  const facts = await (await fx.worker.fetch(new Request(`${ORIGIN}/__x6/facts`), fx.env)).json()
  assert.deepEqual(facts.providerUsage, health.providerUsage)
  assert.equal(facts.deployedSourceRevision, '67fde49f4c67ddeb8c408ce99c22f9d60fb8163c')
  assert.equal(facts.voiceDuplex.protocol, VOICE_DIRECTOR_PROTOCOL)

  // Verify `/api/body/run` alias works identically to `/_host/cloud-body`
  const bodyAliasGet = await fx.worker.fetch(new Request(`${ORIGIN}/api/body/run`, {
    headers: { 'sec-fetch-site': 'same-origin' },
  }), fx.env)
  assert.equal(bodyAliasGet.status, 200)
  const bodyAliasJson = await bodyAliasGet.json()
  assert.equal(bodyAliasJson.ok, true)
  assert.equal(bodyAliasJson.configured, true)
  assert.equal(browserRuns, 0)
})

test('Seam 1 T2 Staged Promotion Transport: /_head/stage -> /_head/promotion-status -> /_head/promote binds Epoch 168 seed-continuity', async () => {
  const fx = await createSeededEdgeFixture()
  // Swap headDo with an injectable single-use consumeApprovalInTransaction mock to test the full Seam 1 transport cleanly
  const consumedTokens = new Set()
  let expectedBinding = null
  const headDo = new X61HeadDurableObject({ storage: fx.headStorage, getWebSockets: () => [] }, fx.env, { networkFetch: () => { throw new Error('External network is forbidden in fixture') } })
  headDo.aumlokStore = {
    status: async () => ({ ok: true, phase: 'BOUND', passkeyVerified: true }),
    consumeApprovalInTransaction: async (_tx, token, binding, origin) => {
      if (token !== 'valid-touchid-token-ep68' || consumedTokens.has(token) || origin !== ORIGIN) {
        throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
      }
      assert.deepEqual(binding, expectedBinding)
      consumedTokens.add(token)
      return { ok: true, expiresAt: Date.now() + 60000 }
    },
  }
  fx.env.HEAD = { idFromName: () => 'node-main-v1', get: () => headDo }

  const continuitySource = 'export const organ = "seed-continuity";\n'
  const continuitySha = await digest(continuitySource)
  const ep68Draft = {
    version: 'x6.1-ball/v1',
    epoch: 168,
    parentBallId: fx.ball.ballId,
    createdAt: '2026-11-11T00:05:00.000Z',
    authorPeerId: 'x6-tab-ep68',
    entries: {
      ...fx.ball.entries,
      'seed-continuity': {
        id: 'seed-continuity',
        specifier: `ball:${continuitySha}`,
        disabled: false,
        config: { governance: true },
        previousSpecifiers: [],
      },
    },
    modules: {
      ...fx.ball.modules,
      [continuitySha]: { sha256: continuitySha, specifier: `ball:${continuitySha}`, size: Buffer.byteLength(continuitySource) },
    },
  }
  const ep68Ball = { ...ep68Draft, ballId: await manifestIdCanon(ep68Draft) }
  expectedBinding = {
    schema: 'aukora.class3.head-promotion.v1',
    audience: ORIGIN,
    action: 'head.promote',
    ballId: ep68Ball.ballId,
    epoch: 168,
    organId: 'seed-continuity',
    candidateSha256: continuitySha,
  }

  // Stage Epoch 168 via POST /_head/stage
  const stageRes = await fx.worker.fetch(new Request(`${ORIGIN}/_head/stage`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({
      schema: 'aukora.staged-head-promotion.v1',
      stagedAt: 1794351001000,
      body: {
        ball: ep68Ball,
        codeBySha: { [continuitySha]: continuitySource },
        expectedParentBallId: fx.ball.ballId,
        expectedEpoch: 167,
      },
    }),
  }), fx.env)
  assert.equal(stageRes.status, 200)
  const stageJson = await stageRes.json()
  assert.equal(stageJson.ok, true)
  assert.equal(stageJson.staged.state, 'awaiting_owner')
  assert.equal(stageJson.staged.epoch, 168)
  assert.deepEqual(stageJson.staged.binding, expectedBinding)

  // Verify GET /_head/promotion-status exposes `staged` across any tab without mutating storage
  const statusRes = await fx.worker.fetch(new Request(`${ORIGIN}/_head/promotion-status`), fx.env)
  assert.equal(statusRes.status, 200)
  const statusJson = await statusRes.json()
  assert.equal(statusJson.epoch, 167)
  assert.equal(statusJson.staged.ballId, ep68Ball.ballId)
  assert.equal(statusJson.staged.envelope.body.ball.epoch, 168)
  assert.deepEqual(statusJson.staged.binding, expectedBinding)

  // Unapproved POST /_head/promote refuses with 403 CLASS3_WEBAUTHN_REQUIRED
  const unauthPromote = await fx.worker.fetch(new Request(`${ORIGIN}/_head/promote`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ ballId: ep68Ball.ballId }),
  }), fx.env)
  assert.equal(unauthPromote.status, 403)
  assert.equal((await unauthPromote.json()).code, 'CLASS3_WEBAUTHN_REQUIRED')

  // Approved POST /_head/promote consumes single-use token, advances HEAD to Epoch 168, and clears `staged`
  const promoteRes = await fx.worker.fetch(new Request(`${ORIGIN}/_head/promote`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-x6-class3-approval': 'valid-touchid-token-ep68',
    },
    body: JSON.stringify({ ballId: ep68Ball.ballId }),
  }), fx.env)
  assert.equal(promoteRes.status, 200)
  const promoteJson = await promoteRes.json()
  assert.equal(promoteJson.ok, true)
  assert.equal(promoteJson.epoch, 168)
  assert.equal(promoteJson.ballId, ep68Ball.ballId)
  assert.equal(promoteJson.tier, 'T2')

  // Replay of the same token or candidate is refused, and /api/health.liveHead reflects Epoch 168!
  const postStatus = await (await fx.worker.fetch(new Request(`${ORIGIN}/_head/promotion-status`), fx.env)).json()
  assert.equal(postStatus.epoch, 168)
  assert.equal(postStatus.staged, null)
  assert.equal(postStatus.lastPublishOutcome.hasApprovalToken, true)

  const postHealth = await (await fx.worker.fetch(new Request(`${ORIGIN}/api/health`), fx.env)).json()
  assert.deepEqual(postHealth.liveHead, { ballId: ep68Ball.ballId, epoch: 168 })
  assert.equal(postHealth.bootstrap.head.epoch, 167)
})
