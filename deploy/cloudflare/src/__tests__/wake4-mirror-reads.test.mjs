/** Live, her 2-step read-only wish died at step 1, twice, with internal / tool /
 * cloud_wake_transport_failed: the mirror refused her 52,349-byte HANDOFF.md with MIRROR_WAKE_FILE_LIMIT (413) and HEAD
 * turned every non-ok mirror answer into a dead step. Now a refused mirror answer with a closed code is the TOOL's
 * refusal (with `mirrorCode`) and the step goes on; a long continuity file answers its newest whole lines; a real
 * transport failure still fails the step and names the tool. Real HEAD and real MIRROR on in-memory storage, a fake
 * DeepSeek in the live shape (calls carry `index`) and a fake GitHub. Her HANDOFF.md is the repo's own copy. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { X61HeadDurableObject, CLOUD_WAKE_PATHS, CLOUD_WAKE_CHECKPOINT_PATH, CLOUD_WAKE_LIMITS, CLOUD_WAKE_CAUSES } from '../head-do.mjs'
import { MirrorDO, mirrorDigest, readMirrorWakeText } from '../mirror-do.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64), OTHER = 'c'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111'
const PREFIX = 'mirror:v2:', FENCE = PREFIX + 'global-fence'
const CHUNK_CHARS = 96 * 1024, CHUNK_BYTES = CHUNK_CHARS / 4 * 3
const SECRET = 'synthetic-provider-value-wake4'
const GH = 'ghp_FIXTUREnotarealvalue0123456789abcd'
const REPO = 'https://api.github.com/repos/your_org_x/your-node'
const HANDOFF_PATH = CLOUD_WAKE_PATHS[0]
const HANDOFF = readFileSync(new URL('../../../../mirror/home/auma/HANDOFF.md', import.meta.url))
const BODY_TEXT = 'MIRROR-BODY-TEXT-never-forward'
const sha = n => String(n).repeat(40).slice(0, 40)
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** One element of `tool_calls` exactly as deepseek-chat sends it (live, 2026-11-14). */
const dsCall = (index, id, name, args = {}) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const deepseekTools = (...calls) => Response.json({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'deepseek-chat',
  choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: calls }, logprobs: null, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
const deepseekSay = content => Response.json({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'deepseek-chat',
  choices: [{ index: 0, message: { role: 'assistant', content }, logprobs: null, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })
const readHandoff = (index, id) => dsCall(index, id, 'readMirrorText', { path: HANDOFF_PATH })

function memoryStorage(initial = []) {
  let rows = new Map(initial), alarm = null, tail = Promise.resolve()
  const reads = []
  const view = (data, timer) => ({
    get: async key => { reads.push(key); return structuredClone(data.get(key)) },
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => { data.delete(key) },
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
    getAlarm: async () => timer.value, setAlarm: async value => { timer.value = value }, deleteAlarm: async () => { timer.value = null },
  })
  const storage = {
    get: key => view(rows, { value: alarm }).get(key),
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
    delete: async key => { rows.delete(key) },
    list: options => view(rows, { value: alarm }).list(options),
    transaction(operation) {
      const result = tail.then(async () => {
        const data = structuredClone(rows), timer = { value: alarm }
        const value = await operation(view(data, timer))
        rows = data; alarm = timer.value
        return value
      })
      tail = result.catch(() => {})
      return result
    },
  }
  return { storage, reads, rows: () => rows }
}

/** One mirrored file in the stored layout (metadata + base64 chunks of CHUNK_CHARS). */
async function putFile(ms, path, bytes, patch = {}) {
  const key = await mirrorDigest(path), b64 = Buffer.from(bytes).toString('base64')
  const chunks = Math.ceil(b64.length / CHUNK_CHARS)
  await ms.storage.put(PREFIX + 'entry:' + key, { path, kind: 'file', mode: 0o600, mtimeMs: 1, bytes: bytes.length, chunks, ...patch })
  for (let index = 0; index < chunks; index++) await ms.storage.put(PREFIX + 'chunk:' + key + ':' + index, b64.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS))
  return key
}

async function mirrorStorage({ files = [[HANDOFF_PATH, HANDOFF]], bootstrapSeed = SEED, fence = { lineageId: LINEAGE, revision: 1 } } = {}) {
  const ms = memoryStorage([['mirror:bootstrap:v1', { phase: 'ready', seedId: bootstrapSeed, lineageId: LINEAGE, revision: 1,
    ballId: BALL, epoch: 2, batchDigests: [OTHER], nextBatch: 1, entryCount: 1, expectedEntries: 1 }], [FENCE, fence]])
  for (const [path, bytes, patch] of files) await putFile(ms, path, bytes, patch)
  return ms
}

function github() {
  const seen = { branches: 0, runs: 0, other: [] }
  const answer = url => {
    if (url === 'https://api.github.com/graphql') {
      seen.branches++
      return Response.json({ data: { repository: { refs: { totalCount: 1, nodes: [{ name: 'sandbox/wake', target: { oid: sha(1) }, compare: { aheadBy: 1, behindBy: 2 } }] } } } })
    }
    if (url === `${REPO}/actions/workflows/auma-exec.yml/runs?per_page=20`) {
      seen.runs++
      return Response.json({ total_count: 1, workflow_runs: [{ id: 5, path: '.github/workflows/auma-exec.yml', status: 'completed', conclusion: 'success',
        created_at: '2026-11-14T01:00:00Z', html_url: 'https://github.com/your_org_x/your-node/actions/runs/5', display_title: 'auma-exec probe-5 @ auma/sandbox/wake' }] })
    }
    seen.other.push(url)
    throw new Error('unexpected GitHub request ' + url)
  }
  return { seen, answer }
}

/**
 * @param {{ answers?: Response[], ms?: object, intercept?: (request: Request, forward: () => Promise<Response>) => Promise<Response>,
 *   sockets?: object[], wish?: object, rows?: [string, unknown][] }} options
 */
async function fixture(t, { answers = [], ms, intercept, sockets = [], wish = {}, rows = [] } = {}) {
  const now = 1000000
  const hs = memoryStorage([['bootstrap:v1', { phase: 'complete', seedId: SEED }], ['head:current', { ballId: BALL, epoch: 2, entries: {} }],
    ['head:wish:active', { wish_id: 'w1', intent: 'Read my notes, then look at my own work', acceptance: 'Two read steps recorded', status: 'running', stepsCompleted: 0, maxSteps: 6, ...wish }],
    ...rows])
  const mirrorStore = ms ?? await mirrorStorage()
  const mirror = new MirrorDO({ storage: mirrorStore.storage }, {})
  const mirrorCalls = []
  const env = { DEEPSEEK_API_KEY: SECRET, CLOUD_WAKE_PROVIDER: 'deepseek', GITHUB_TOKEN: GH, PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '100',
    PROVIDER_BUDGET_TOKENS: '10000000', PROVIDER_MAX_OUTPUT_TOKENS: '400', WAKE_EXECUTOR_ENABLED: '1',
    MIRROR: { idFromName: name => name, get: () => ({ fetch: request => {
      mirrorCalls.push(new URL(request.url).pathname)
      return intercept ? intercept(request, () => mirror.fetch(request)) : mirror.fetch(request)
    } }) } }
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  const hub = github(), requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith('https://api.github.com/')) return hub.answer(String(url), init)
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
    requests.push(JSON.parse(init.body))
    const answer = answers.shift()
    assert.notEqual(answer, undefined, 'Unexpected provider round')
    return answer
  })
  const head = new X61HeadDurableObject({ storage: hs.storage, getWebSockets: () => sockets }, env)
  t.after(() => head.wakeStore.dispose())
  head.broadcast = async () => {}
  const post = async (body, path = '/_head/transcript') => {
    const response = await head.fetch(new Request('https://wake.example.invalid' + path, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(body) }))
    assert.equal(response.status, 200)
    return response.json()
  }
  const transcript = () => [...hs.rows()].filter(([key]) => key.startsWith('head:transcript:row:')).map(([, row]) => row)
  /** The tool answers the model saw, by call id (from the request after the round that asked for them). */
  const toolAnswers = () => Object.fromEntries(requests.flatMap(body => body.messages.filter(message => message.role === 'tool'))
    .map(message => [message.tool_call_id, JSON.parse(message.content)]))
  return { head, hs, mirrorStore, hub, requests, mirrorCalls, post, transcript, toolAnswers, now, wish: () => hs.storage.get('head:wish:active'),
    step: (options = {}) => head.executeCloudWakeStep({ now, ...options }), day: () => hs.storage.get('head:wake:daily:1970-01-01'), advance: ms => { clock += ms } }
}

/** What the newest-part read must be for `bytes`: a suffix of whole lines, at most textBytes, valid UTF-8. */
function assertNewestPart(answer, bytes) {
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.equal(answer.truncated, true)
  assert.equal(answer.totalBytes, bytes.length)
  const slice = Buffer.from(answer.text, 'utf8')
  assert.ok(slice.length <= CLOUD_WAKE_LIMITS.textBytes, String(slice.length))
  assert.ok(slice.length > 0)
  assert.equal(answer.fromByte + slice.length, bytes.length)
  assert.equal(bytes[answer.fromByte - 1], 0x0a, 'the cut falls just after a newline')
  assert.deepEqual(slice, Buffer.from(bytes.subarray(answer.fromByte)))
  assert.equal(utf8.decode(bytes.subarray(answer.fromByte)), answer.text)
  // Every whole line that fits is returned: one more line would pass the bound.
  const previousLineStart = bytes.lastIndexOf(0x0a, answer.fromByte - 2) + 1
  assert.ok(bytes.length - previousLineStart > CLOUD_WAKE_LIMITS.textBytes)
}

test('(a) her real HANDOFF.md (many times the 4,096-byte bound): readMirrorText answers the newest part, listMyBranches runs, the step SUCCEEDS', async t => {
  // Lead, 2026-11-14: her notes are a LIVING file (every home sync changes them; they were 52,349 bytes when this was
  // written and 53,648 one sync later). The case needs a file far over the bound, not one exact size.
  assert.ok(HANDOFF.length > 10 * CLOUD_WAKE_LIMITS.textBytes, String(HANDOFF.length))
  const f = await fixture(t, { answers: [deepseekTools(readHandoff(0, 'call_00_read'), dsCall(1, 'call_01_br', 'listMyBranches')), deepseekSay('I read my notes and my branch.')] })
  const out = await f.step()
  assert.equal(out.status, 'success', JSON.stringify(out))
  assert.equal(out.toolCalls, 2)
  assert.equal(Object.hasOwn(out, 'toolRefusals'), false, JSON.stringify(out.toolRefusals))
  const read = f.toolAnswers().call_00_read
  assertNewestPart(read, HANDOFF)
  assert.equal(read.path, HANDOFF_PATH)
  assert.equal(read.revision, 1)
  assert.equal(f.toolAnswers().call_01_br.ok, true)
  assert.equal(f.hub.seen.branches, 1)
  assert.deepEqual(f.mirrorCalls, ['/_mirror/wake-read'])
  const wish = await f.wish()
  assert.equal(wish.stepsCompleted, 1)
  assert.equal(wish.stepFailures === undefined || wish.stepFailures.length === 0, true, JSON.stringify(wish.stepFailures))
})

test('(b) a 2-step wish: step 1 reads her notes and branches, step 2 her runner jobs; stepsCompleted 2, no stepFailures', async t => {
  const f = await fixture(t, { answers: [
    deepseekTools(readHandoff(0, 'call_00_s1r'), dsCall(1, 'call_01_s1b', 'listMyBranches')), deepseekSay('Step 1: notes and one branch read.'),
    deepseekTools(dsCall(0, 'call_00_s2', 'execRuns')), deepseekSay('Step 2: one runner job, completed.'),
  ] })
  assert.equal((await f.step()).status, 'success')
  const second = await f.step()
  assert.equal(second.status, 'success', JSON.stringify(second))
  const wish = await f.wish()
  assert.equal(wish.stepsCompleted, 2)
  assert.equal(wish.status, 'running')
  assert.deepEqual(wish.steps.map(row => [row.step, row.toolCalls]), [[1, 2], [2, 1]])
  assert.equal(wish.stepFailures === undefined || wish.stepFailures.length === 0, true, JSON.stringify(wish.stepFailures))
  assert.deepEqual([f.hub.seen.branches, f.hub.seen.runs], [1, 1])
  const status = await f.post({ action: 'wish_status' })
  assert.deepEqual(status.stepFailures, [])
  assert.equal(JSON.stringify(wish).includes(SECRET), false)
})

for (const [label, mirrorCode, build, extra = {}] of [
  ['credential-shaped text', 'MIRROR_WAKE_TEXT_REFUSED', () => mirrorStorage({ files: [[HANDOFF_PATH, Buffer.from('notes\npassword=synthetic-secret\n')]] }), { atByte: 6 }],
  ['malformed file metadata', 'MIRROR_WAKE_FILE_INVALID', () => mirrorStorage({ files: [[HANDOFF_PATH, HANDOFF, { mode: -1 }]] })],
  ['a mirror seeded by another seed', 'BOOTSTRAP_REQUIRED', () => mirrorStorage({ bootstrapSeed: OTHER })],
  ['a fence of another lineage', 'MIRROR_GLOBAL_FENCE_CORRUPT', () => mirrorStorage({ fence: { lineageId: '22222222-2222-4222-8222-222222222222', revision: 1 } })],
  ['an absent file', 'MIRROR_WAKE_FILE_ABSENT', () => mirrorStorage({ files: [] })],
]) {
  test(`(c) ${label}: the read is a tool refusal with mirrorCode ${mirrorCode}; the step goes on to listMyBranches and succeeds`, async t => {
    const f = await fixture(t, { ms: await build(), answers: [deepseekTools(readHandoff(0, 'call_00_read'), dsCall(1, 'call_01_br', 'listMyBranches')), deepseekSay('Notes unavailable; one branch read.')] })
    const out = await f.step()
    assert.equal(out.status, 'success', JSON.stringify(out))
    assert.deepEqual(out.toolRefusals, [{ tool: 'readMirrorText', code: 'cloud_wake_read_unavailable', mirrorCode: mirrorCode.toLowerCase(), ...extra }])
    assert.deepEqual(f.toolAnswers().call_00_read, { ok: false, code: 'CLOUD_WAKE_READ_UNAVAILABLE', mirrorCode, ...extra })
    assert.equal(f.toolAnswers().call_01_br.ok, true)
    assert.equal(f.hub.seen.branches, 1)
    const wish = await f.wish()
    assert.equal(wish.stepsCompleted, 1)
    assert.equal(wish.stepFailures === undefined || wish.stepFailures.length === 0, true, JSON.stringify(wish.stepFailures))
  })
}

test('(c) only the closed code travels: other text in a refused mirror body reaches no answer, transcript row or wish', async t => {
  const f = await fixture(t, {
    answers: [deepseekTools(readHandoff(0, 'call_00_read'), dsCall(1, 'call_01_br', 'listMyBranches')), deepseekSay('Notes refused; one branch read.')],
    intercept: async () => Response.json({ ok: false, code: 'MIRROR_WAKE_TEXT_REFUSED', detail: BODY_TEXT }, { status: 403 }),
  })
  const out = await f.post({ action: 'wish_step' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(out.toolRefusals, [{ tool: 'readMirrorText', code: 'cloud_wake_read_unavailable', mirrorCode: 'mirror_wake_text_refused' }])
  assert.deepEqual(f.toolAnswers().call_00_read, { ok: false, code: 'CLOUD_WAKE_READ_UNAVAILABLE', mirrorCode: 'MIRROR_WAKE_TEXT_REFUSED' })
  for (const text of [JSON.stringify(out), JSON.stringify(f.transcript()), JSON.stringify(await f.wish()), JSON.stringify(f.requests)]) assert.equal(text.includes(BODY_TEXT), false)
})

for (const [label, intercept] of [
  ['a mirror fetch that throws', async () => { throw new Error(BODY_TEXT) }],
  ['a non-ok answer that is not JSON', async () => new Response(BODY_TEXT, { status: 502 })],
  ['a non-ok answer whose code is not closed', async () => Response.json({ ok: false, code: 'not a closed code' }, { status: 500 })],
  ['a non-ok answer with no code', async () => Response.json({ ok: false }, { status: 500 })],
  ['a non-ok answer over 1 KiB', async () => Response.json({ ok: false, code: 'MIRROR_WAKE_TEXT_REFUSED', pad: 'p'.repeat(2048) }, { status: 403 })],
]) {
  test(`(d) ${label}: the step fails as internal / tool / cloud_wake_transport_failed and names tool readMirrorText`, async t => {
    const f = await fixture(t, { intercept, answers: [deepseekTools(readHandoff(0, 'call_00_read'), dsCall(1, 'call_01_br', 'listMyBranches'))] })
    const out = await f.post({ action: 'wish_step' })
    assert.equal(out.ok, false)
    assert.equal(out.probeStatus, 'failed')
    assert.equal(out.cause, 'internal')
    assert.equal(out.where, 'tool')
    assert.equal(out.code, 'cloud_wake_transport_failed')
    assert.equal(out.tool, 'readMirrorText')
    assert.equal(f.hub.seen.branches, 0, 'the step stopped at the failed read')
    const wish = await f.wish()
    assert.equal(wish.stepsCompleted, 0)
    const failure = wish.stepFailures.at(-1)
    assert.deepEqual([failure.reason, failure.where, failure.code, failure.tool], ['internal', 'tool', 'cloud_wake_transport_failed', 'readMirrorText'])
    const status = await f.post({ action: 'wish_status' })
    assert.equal(status.stepFailures.at(-1).tool, 'readMirrorText')
    for (const text of [JSON.stringify(out), JSON.stringify(status), JSON.stringify(f.transcript())]) assert.equal(text.includes(BODY_TEXT), false)
  })
}

test('(e) the newest part is valid UTF-8 when the byte bound falls inside a multi-byte character, and never passes 4096 bytes', async () => {
  // Lines of two- and four-byte characters: the raw last-4096-bytes boundary falls inside a character.
  const lines = Array.from({ length: 400 }, (_, index) => `${index} ${'é'.repeat(7)}𝄞 ${'ü'.repeat(index % 13)}`).join('\n') + '\n'
  const bytes = Buffer.from(lines, 'utf8')
  const rawStart = bytes.length - CLOUD_WAKE_LIMITS.textBytes
  assert.equal((bytes[rawStart] & 0xc0) === 0x80, true, 'the raw byte bound is inside a character')
  const ms = await mirrorStorage({ files: [[HANDOFF_PATH, bytes]] })
  assertNewestPart(await readMirrorWakeText(ms.storage, { path: HANDOFF_PATH, seedId: SEED }), bytes)
  // A file of exactly the bound answers whole, as before (no truncated field).
  const exact = Buffer.from('x'.repeat(CLOUD_WAKE_LIMITS.textBytes - 1) + '\n')
  const whole = await readMirrorWakeText((await mirrorStorage({ files: [[HANDOFF_PATH, exact]] })).storage, { path: HANDOFF_PATH, seedId: SEED })
  assert.deepEqual(whole, { ok: true, path: HANDOFF_PATH, text: exact.toString(), revision: 1 })
})

test('(e) a long file over several stored chunks: the newest part comes back, and every chunk is read for the screen (review D)', async () => {
  const line = index => `line ${String(index).padStart(6, '0')} ${'n'.repeat(48)}\n`
  let text = ''
  for (let index = 0; Buffer.byteLength(text) < 2 * CHUNK_BYTES + 3000; index++) text += line(index)
  const bytes = Buffer.from(text)
  const ms = await mirrorStorage({ files: [[HANDOFF_PATH, bytes]] })
  const key = await mirrorDigest(HANDOFF_PATH)
  ms.reads.length = 0
  const answer = await readMirrorWakeText(ms.storage, { path: HANDOFF_PATH, seedId: SEED })
  assertNewestPart(answer, bytes)
  const chunkReads = ms.reads.filter(name => name.startsWith(PREFIX + 'chunk:' + key)).map(name => Number(name.split(':').at(-1)))
  assert.deepEqual(chunkReads, Array.from({ length: Math.ceil(bytes.length / CHUNK_BYTES) }, (_, index) => index))
})

test('(e) a credential is still refused: in the newest part, just before the cut, or a private key whose BEGIN line was cut off', async () => {
  const filler = count => Array.from({ length: count }, (_, index) => `ordinary note ${index} ${'z'.repeat(40)}`).join('\n') + '\n'
  const base64Line = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2'
  for (const [label, text, after] of [
    ['a secret line in the newest part', filler(200) + 'api_key = synthetic-wake4-value\n' + filler(10), filler(10)],
    ['a Bearer line just before the cut', filler(200) + 'Authorization: Bearer synthetic-wake4-value\n' + filler(100), filler(100)],
    ['a private key whose BEGIN line was cut off', filler(200) + '-----BEGIN PRIVATE KEY-----\n' + `${base64Line}\n`.repeat(160) + '-----END PRIVATE KEY-----\n' + filler(3), null],
  ]) {
    const bytes = Buffer.from(text)
    assert.ok(bytes.length > CLOUD_WAKE_LIMITS.textBytes, label)
    // The case is what its label says: the secret line inside, or before, the newest 4096 bytes.
    if (after !== null) assert.equal(Buffer.byteLength(after) > CLOUD_WAKE_LIMITS.textBytes, label.includes('before the cut'), label)
    const ms = await mirrorStorage({ files: [[HANDOFF_PATH, bytes]] })
    await assert.rejects(readMirrorWakeText(ms.storage, { path: HANDOFF_PATH, seedId: SEED }), error => error.code === 'MIRROR_WAKE_TEXT_REFUSED' && error.status === 403, label)
  }
  // A long tail with no newline in its newest 4096 bytes cannot be cut on a line: refused as before (413).
  const noLines = await mirrorStorage({ files: [[HANDOFF_PATH, Buffer.from('x'.repeat(CLOUD_WAKE_LIMITS.textBytes + 1))]] })
  await assert.rejects(readMirrorWakeText(noLines.storage, { path: HANDOFF_PATH, seedId: SEED }), error => error.code === 'MIRROR_WAKE_FILE_LIMIT' && error.status === 413)
})

test('(e) through the step: a secret line in her long notes is a tool refusal (mirror_wake_text_refused), never in a request', async t => {
  const bytes = Buffer.from(HANDOFF.toString() + 'password: synthetic-wake4-pass\n')
  const f = await fixture(t, { ms: await mirrorStorage({ files: [[HANDOFF_PATH, bytes]] }),
    answers: [deepseekTools(readHandoff(0, 'call_00_read'), dsCall(1, 'call_01_br', 'listMyBranches')), deepseekSay('Notes refused.')] })
  const out = await f.step()
  assert.equal(out.status, 'success', JSON.stringify(out))
  // Second review: the refusal says where the line starts (a number), never its text.
  assert.deepEqual(out.toolRefusals, [{ tool: 'readMirrorText', code: 'cloud_wake_read_unavailable', mirrorCode: 'mirror_wake_text_refused', atByte: HANDOFF.length }])
  assert.equal(JSON.stringify(f.requests).includes('synthetic-wake4-pass'), false)
  assert.equal(JSON.stringify(f.transcript()).includes('synthetic-wake4-pass'), false)
})

test('(f) appendWakeCheckpoint refused by the mirror is a tool refusal with mirrorCode, not a dead step', async t => {
  // The checkpoint file is full (128 rows): the mirror answers MIRROR_WAKE_CHECKPOINT_FULL (507).
  const row = index => JSON.stringify({ schema: 'aukora.cloud-wake-checkpoint.v1', id: index.toString(16).padStart(64, '0'), at: 1000,
    head: { ballId: BALL, epoch: 2 }, evidence: [{ tool: 'inspectHeadWish', digest: 'd'.repeat(64) }] })
  const full = Buffer.from(Array.from({ length: 128 }, (_, index) => row(index)).join('\n') + '\n')
  const ms = await mirrorStorage({ files: [[HANDOFF_PATH, HANDOFF], [CLOUD_WAKE_CHECKPOINT_PATH, full]] })
  const f = await fixture(t, { ms, answers: [
    deepseekTools(dsCall(0, 'call_00_look', 'inspectHeadWish'), dsCall(1, 'call_01_cp', 'appendWakeCheckpoint'), dsCall(2, 'call_02_br', 'listMyBranches')),
    deepseekSay('Looked; the checkpoint was refused; one branch read.'),
  ] })
  const out = await f.step()
  assert.equal(out.status, 'success', JSON.stringify(out))
  assert.deepEqual(out.toolRefusals, [{ tool: 'appendWakeCheckpoint', code: 'cloud_wake_checkpoint_unavailable', mirrorCode: 'mirror_wake_checkpoint_full' }])
  assert.deepEqual(f.toolAnswers().call_01_cp, { ok: false, code: 'CLOUD_WAKE_CHECKPOINT_UNAVAILABLE', mirrorCode: 'MIRROR_WAKE_CHECKPOINT_FULL' })
  assert.equal(f.toolAnswers().call_02_br.ok, true)
  assert.deepEqual(f.mirrorCalls, ['/_mirror/wake-checkpoint'])
  assert.equal((await f.wish()).stepsCompleted, 1)
})

test('(f) a checkpoint whose mirror fetch throws fails the step and names tool appendWakeCheckpoint', async t => {
  const f = await fixture(t, { intercept: async () => { throw new Error(BODY_TEXT) },
    answers: [deepseekTools(dsCall(0, 'call_00_look', 'inspectHeadWish'), dsCall(1, 'call_01_cp', 'appendWakeCheckpoint'))] })
  const out = await f.step()
  assert.equal(out.status, 'failed')
  assert.deepEqual([out.cause, out.where, out.code, out.tool], ['internal', 'tool', 'cloud_wake_transport_failed', 'appendWakeCheckpoint'])
  assert.equal((await f.wish()).stepFailures.at(-1).tool, 'appendWakeCheckpoint')
})

// ---- Review (A to E) ----
const CLAIM = 'head:wake:step-claim'
/** A WebSocket as HEAD's /_head/ws upgrade attaches it: `{ bootstrapSeed, peer }` (peer null until presence:hello). */
const socket = (bootstrapSeed, peer = null) => ({ deserializeAttachment: () => ({ bootstrapSeed, peer }) })
const lookThenCheckpoint = () => deepseekTools(dsCall(0, 'call_00_look', 'inspectHeadWish'), dsCall(1, 'call_01_cp', 'appendWakeCheckpoint'))

test('(A) two runs of one step at once (her manual step and the alarm): one provider call, one day count, one step row; the other answers step_running', async t => {
  assert.ok(CLOUD_WAKE_CAUSES.includes('step_running'))
  const f = await fixture(t, { answers: [deepseekSay('One step, observed.')] })
  const [manual, alarm] = await Promise.all([f.step(), f.step({ via: 'alarm' })])
  assert.equal(manual.status, 'success', JSON.stringify(manual))
  assert.deepEqual(alarm, { status: 'blocked', cause: 'step_running' })
  assert.equal(f.requests.length, 1)
  assert.equal(await f.day(), 1)
  const wish = await f.wish()
  assert.equal(wish.stepsCompleted, 1)
  assert.equal(wish.steps.length, 1)
  assert.equal(wish.stepFailures === undefined || wish.stepFailures.length === 0, true, JSON.stringify(wish.stepFailures))
  assert.equal(await f.hs.storage.get(CLAIM), undefined, 'the claim is cleared when the step ends')
})

test('(A) a live claim blocks with no count, no call and no failure row; a stale claim (past until) does not block', async t => {
  const live = await fixture(t, { rows: [[CLAIM, { wishId: 'w1', step: 1, startedAt: 999000, until: 1000000 + 1, runId: 'other-run' }]] })
  assert.deepEqual(await live.step(), { status: 'blocked', cause: 'step_running' })
  assert.equal(live.requests.length, 0)
  assert.equal(await live.day(), undefined)
  assert.equal((await live.wish()).stepFailures, undefined)
  assert.equal((await live.hs.storage.get(CLAIM)).runId, 'other-run', 'another run\'s claim is never cleared')
  const stale = await fixture(t, { answers: [deepseekSay('Observed.')], rows: [[CLAIM, { wishId: 'w1', step: 1, startedAt: 900000, until: 1000000, runId: 'crashed-run' }]] })
  assert.equal((await stale.step()).status, 'success')
  assert.equal(stale.requests.length, 1)
  assert.equal(await stale.hs.storage.get(CLAIM), undefined)
})

test('(A) wakeAlarmSkip: inside the wish\'s interval since its last step started (or under a live claim) a scheduled tick skips; outside it, and a manual step, run', async t => {
  const soon = await fixture(t, { wish: { everySeconds: 60, stepsCompleted: 1, lastStepAt: 1000000 - 10000, steps: [{ step: 1, at: 1000000 - 10000, outcome: 'no_tool_evidence', toolCalls: 0 }] } })
  assert.equal(await soon.head.wakeAlarmSkip(1000000), 'step_interval')
  const due = await fixture(t, { wish: { everySeconds: 60, stepsCompleted: 1, lastStepAt: 1000000 - 60000 } })
  assert.equal(await due.head.wakeAlarmSkip(1000000), null)
  const claimed = await fixture(t, { rows: [[CLAIM, { wishId: 'w1', step: 1, startedAt: 999000, until: 1000001, runId: 'r' }]] })
  assert.equal(await claimed.head.wakeAlarmSkip(1000000), 'step_running')
  const manual = await fixture(t, { answers: [deepseekSay('Observed.')], wish: { everySeconds: 60, stepsCompleted: 1, lastStepAt: 1000000 - 10000 } })
  assert.equal((await manual.step()).status, 'success')
  assert.equal(manual.requests.length, 1)
})

test('(A) through HEAD\'s real alarm(): a tick 10 s after the last step calls no provider; the owner\'s /_host/wake trigger still steps', async t => {
  const f = await fixture(t, { answers: [deepseekSay('Stepped on his trigger.')], wish: { everySeconds: 60, stepsCompleted: 1, lastStepAt: 1000000 + 60000 - 10000 } })
  await f.head.wakeStore.configure({ enabled: true, intervalMs: 60000 })
  f.advance(60000)
  const before = await f.head.wakeStore.status()
  const tick = await f.head.alarm()
  assert.equal(tick.skipped, 'step_interval')
  assert.equal(tick.receipt, undefined, 'a skipped tick is no wake: no receipt')
  assert.equal(f.requests.length, 0, 'the scheduled tick inside the interval calls no provider')
  const after = await f.head.wakeStore.status()
  assert.deepEqual([after.wakeCount, after.consecutiveUnacknowledgedWakes, after.receipts.length], [before.wakeCount, before.consecutiveUnacknowledgedWakes, before.receipts.length])
  assert.equal(after.scheduleStatus, 'scheduled', 'the next alarm stays scheduled')
  const trigger = await f.post({ action: 'trigger' }, '/_host/wake')
  assert.equal(trigger.receipt.executor.status, 'probe_succeeded')
  assert.equal(f.requests.length, 1, 'his own trigger is never skipped')
  assert.equal((await f.wish()).stepsCompleted, 2)
})

for (const [label, sockets] of [['an announced tab (its peer row an hour old)', [socket(SEED, { peerId: 'tab-1', kind: 'browser-tab', lastSeenAt: 1 })]],
  ['a tab connected but not yet announced', [socket(SEED)]]]) {
  test(`(B) ${label}: the checkpoint is refused WITHOUT calling the mirror, the fence does not move, the step counts`, async t => {
    const f = await fixture(t, { sockets, answers: [lookThenCheckpoint(), deepseekSay('Looked; no checkpoint while my tab is open.')] })
    const out = await f.step()
    assert.equal(out.status, 'success', JSON.stringify(out))
    assert.deepEqual(out.toolRefusals, [{ tool: 'appendWakeCheckpoint', code: 'cloud_wake_checkpoint_unavailable', mirrorCode: 'mirror_wake_writer_live' }])
    assert.deepEqual(f.toolAnswers().call_01_cp, { ok: false, code: 'CLOUD_WAKE_CHECKPOINT_UNAVAILABLE', mirrorCode: 'MIRROR_WAKE_WRITER_LIVE' })
    assert.deepEqual(f.mirrorCalls, [], 'zero checkpoint requests reach the mirror')
    assert.deepEqual(await f.mirrorStore.storage.get(FENCE), { lineageId: LINEAGE, revision: 1 })
    assert.equal((await f.wish()).stepsCompleted, 1)
  })
}

test('(B) with no tab (or only a socket of another seed) the checkpoint is written as before and the fence moves', async t => {
  for (const sockets of [[], [socket(OTHER, { peerId: 'old', kind: 'browser-tab', lastSeenAt: 1 })]]) {
    const f = await fixture(t, { sockets, answers: [lookThenCheckpoint(), deepseekSay('Looked and checkpointed.')] })
    const out = await f.step()
    assert.equal(out.status, 'success', JSON.stringify(out))
    assert.equal(Object.hasOwn(out, 'toolRefusals'), false)
    assert.equal(f.toolAnswers().call_01_cp.ok, true)
    assert.deepEqual(f.mirrorCalls, ['/_mirror/wake-checkpoint'])
    assert.equal((await f.mirrorStore.storage.get(FENCE)).revision, 2)
  }
})

test('(C) ten parallel calls in round 1: eight run, two are answered cloud_wake_tool_limit (every id answered), round 2 must answer', async t => {
  const calls = Array.from({ length: 10 }, (_, index) => dsCall(index, `call_${index}`, 'inspectHeadWish'))
  const f = await fixture(t, { answers: [deepseekTools(...calls), deepseekSay('Inspected eight times.')] })
  const out = await f.step()
  assert.equal(out.status, 'success', JSON.stringify(out))
  assert.equal(out.toolCalls, CLOUD_WAKE_LIMITS.calls)
  assert.equal(out.evidenceCount, CLOUD_WAKE_LIMITS.calls, 'no ninth tool ran')
  assert.deepEqual(out.toolRefusals, [{ tool: 'inspectHeadWish', code: 'cloud_wake_tool_limit' }, { tool: 'inspectHeadWish', code: 'cloud_wake_tool_limit' }])
  const answers = f.toolAnswers()
  assert.deepEqual(Object.keys(answers), calls.map(call => call.id))
  assert.deepEqual([answers.call_8, answers.call_9], [{ ok: false, code: 'CLOUD_WAKE_TOOL_LIMIT' }, { ok: false, code: 'CLOUD_WAKE_TOOL_LIMIT' }])
  assert.deepEqual(f.requests.map(body => body.tool_choice), ['auto', 'none'])
})

test('(C) five calls then five: three run in round 2, two are refused; a forced round that still calls is refused whole and the next is forced too', async t => {
  const batch = prefix => Array.from({ length: 5 }, (_, index) => dsCall(index, `${prefix}_${index}`, 'inspectHeadWish'))
  const f = await fixture(t, { answers: [deepseekTools(...batch('r1')), deepseekTools(...batch('r2')), deepseekTools(dsCall(0, 'r3_0', 'listMyBranches')), deepseekSay('Done.')] })
  const out = await f.step()
  assert.equal(out.status, 'success', JSON.stringify(out))
  assert.equal(out.toolCalls, CLOUD_WAKE_LIMITS.calls)
  assert.deepEqual(out.toolRefusals.map(row => row.code), Array(3).fill('cloud_wake_tool_limit'))
  assert.deepEqual(f.requests.map(body => body.tool_choice), ['auto', 'auto', 'none', 'none'])
  assert.equal(f.hub.seen.branches, 0, 'a call on a forced round never runs')
  assert.deepEqual(f.toolAnswers().r3_0, { ok: false, code: 'CLOUD_WAKE_TOOL_LIMIT' })
})

test('(C) a call on the 4th round still fails the step: no 5th round exists to send its answer in', async t => {
  const f = await fixture(t, { answers: [1, 2, 3, 4].map(round => deepseekTools(dsCall(0, `round_${round}`, 'inspectHeadWish'))) })
  const out = await f.step()
  assert.deepEqual([out.status, out.cause, out.code], ['failed', 'tool_refused', 'cloud_wake_tool_limit'])
  assert.equal(f.requests.length, CLOUD_WAKE_LIMITS.rounds)
})

test('(D) a credential marker far above the cut: `private_key: |` then 9 KiB of bare base64 lines to the end is refused', async () => {
  const base64Line = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2'
  const text = 'ordinary notes\n'.repeat(40) + 'private_key: |\n' + `  ${base64Line}\n`.repeat(Math.ceil(9 * 1024 / (base64Line.length + 3)))
  const tail = Buffer.from(text.slice(text.indexOf('private_key: |\n') + 'private_key: |\n'.length))
  assert.ok(tail.length > 2 * CLOUD_WAKE_LIMITS.textBytes, 'the marker line is more than 8 KiB from the end')
  const ms = await mirrorStorage({ files: [[HANDOFF_PATH, Buffer.from(text)]] })
  await assert.rejects(readMirrorWakeText(ms.storage, { path: HANDOFF_PATH, seedId: SEED }), error => error.code === 'MIRROR_WAKE_TEXT_REFUSED' && error.status === 403)
})

test('(E) an alarm-driven step that succeeds keeps its refused calls (with mirrorCode) on its step row, and x6_wish status shows them', async t => {
  const f = await fixture(t, { ms: await mirrorStorage({ files: [] }), answers: [deepseekTools(readHandoff(0, 'call_00_read'), dsCall(1, 'call_01_br', 'listMyBranches')), deepseekSay('Notes absent; one branch read.')] })
  const out = await f.step({ via: 'alarm' })
  assert.equal(out.status, 'success', JSON.stringify(out))
  const rows = [{ tool: 'readMirrorText', code: 'cloud_wake_read_unavailable', mirrorCode: 'mirror_wake_file_absent' }]
  assert.deepEqual((await f.wish()).steps.at(-1).toolRefusals, rows)
  const status = await f.post({ action: 'wish_status' })
  assert.deepEqual(status.steps.at(-1).toolRefusals, rows)
})

test('(E) the stored rows stay bounded: a name the model made up is kept as unknown_tool, and only the newest 8 step rows keep refusals', async t => {
  const old = Array.from({ length: 10 }, (_, index) => ({ step: index + 1, at: 1000 + index, outcome: 'no_tool_evidence', toolCalls: 1,
    toolRefusals: [{ tool: 'readMirrorText', code: 'cloud_wake_read_unavailable', mirrorCode: 'mirror_wake_file_absent' }] }))
  const f = await fixture(t, { wish: { stepsCompleted: 10, maxSteps: 24, steps: old },
    answers: [deepseekTools(dsCall(0, 'call_00_x', 'aMadeUpToolNameTheModelChose')), deepseekSay('Nothing ran.')] })
  const out = await f.step()
  assert.equal(out.status, 'success', JSON.stringify(out))
  const steps = (await f.wish()).steps
  assert.deepEqual(steps.at(-1).toolRefusals, [{ tool: 'unknown_tool', code: 'cloud_wake_tool_refused' }])
  assert.equal(steps.filter(row => Object.hasOwn(row, 'toolRefusals')).length, 8)
  assert.deepEqual(steps.slice(-8).map(row => Object.hasOwn(row, 'toolRefusals')), Array(8).fill(true))
  assert.equal(JSON.stringify(steps).includes('aMadeUpToolNameTheModelChose'), false)
})

// ---- Second review (1 to 5) ----
test('(2nd-1) three scheduled ticks that each land on a live step claim are skips, not strikes: the schedule never pauses itself', async t => {
  const f = await fixture(t)
  await f.head.wakeStore.configure({ enabled: true, intervalMs: 60000 })
  for (let tick = 1; tick <= 3; tick++) {
    f.advance(60000)
    await f.hs.storage.put(CLAIM, { wishId: 'w1', step: 1, startedAt: 1000000 + tick * 60000 - 1000, until: 1000000 + tick * 60000 + 30000, runId: `tab-run-${tick}` })
    const out = await f.head.alarm()
    assert.equal(out.skipped, 'step_running', JSON.stringify(out))
  }
  const status = await f.head.wakeStore.status()
  assert.deepEqual([status.enabled, status.autoPaused, status.consecutiveUnacknowledgedWakes, status.receipts.length], [true, false, 0, 0])
  assert.equal(status.scheduleStatus, 'scheduled')
  assert.equal(f.requests.length, 0)
})

test('(2nd-2) a skip leaves the failure streak as it was: fail, fail, her manual step, a skipped tick, fail = paused', async t => {
  const refused = () => new Response(JSON.stringify({ error: { message: 'synthetic' } }), { status: 401, headers: { 'content-type': 'application/json' } })
  const f = await fixture(t, { answers: [refused(), refused(), deepseekSay('Manual step, observed.'), refused()] })
  await f.head.wakeStore.configure({ enabled: true, intervalMs: 60000 })
  f.advance(60000); assert.equal((await f.head.alarm()).consecutiveUnacknowledgedWakes, 1)
  f.advance(60000); assert.equal((await f.head.alarm()).consecutiveUnacknowledgedWakes, 2)
  f.advance(50000); assert.equal((await f.post({ action: 'wish_step' })).ok, true)
  f.advance(10000)
  const skip = await f.head.alarm()
  assert.equal(skip.skipped, 'step_interval')
  assert.equal(skip.receipt, undefined)
  assert.equal((await f.head.wakeStore.status()).consecutiveUnacknowledgedWakes, 2, 'the streak is unchanged by a skip')
  f.advance(60000)
  const third = await f.head.alarm()
  assert.deepEqual([third.consecutiveUnacknowledgedWakes, third.autoPaused, third.enabled], [3, true, false])
  assert.equal(f.requests.length, 4)
})

test('(2nd-3) one answer with more than 16 calls still fails the step and writes no tool row; 16 are answered softly', async t => {
  const many = count => Array.from({ length: count }, (_, index) => dsCall(index, `call_${index}`, 'inspectHeadWish'))
  const over = await fixture(t, { answers: [deepseekTools(...many(17))] })
  const out = await over.step()
  assert.deepEqual([out.status, out.cause, out.code], ['failed', 'tool_refused', 'cloud_wake_tool_limit'])
  assert.equal(over.transcript().filter(row => row.role === 'tool').length, 0)
  const sixteen = await fixture(t, { answers: [deepseekTools(...many(16)), deepseekSay('Eight inspected.')] })
  const soft = await sixteen.step()
  assert.equal(soft.status, 'success', JSON.stringify(soft))
  assert.equal(soft.toolCalls, 8)
  assert.equal(soft.toolRefusals.length, 8)
  assert.equal(sixteen.transcript().filter(row => row.role === 'tool').length, 16)
})

test('(2nd-4) a continuity file over 1 MiB is refused (413 MIRROR_WAKE_FILE_LIMIT) before any chunk is read, and softly in a step', async t => {
  const line = index => `line ${String(index).padStart(7, '0')} ${'m'.repeat(50)}\n`
  let text = ''
  for (let index = 0; Buffer.byteLength(text) <= 1024 * 1024 + 10; index++) text += line(index)
  const bytes = Buffer.from(text)
  const ms = await mirrorStorage({ files: [[HANDOFF_PATH, bytes]] })
  const key = await mirrorDigest(HANDOFF_PATH)
  ms.reads.length = 0
  await assert.rejects(readMirrorWakeText(ms.storage, { path: HANDOFF_PATH, seedId: SEED }), error => error.code === 'MIRROR_WAKE_FILE_LIMIT' && error.status === 413)
  assert.equal(ms.reads.some(name => name.startsWith(PREFIX + 'chunk:' + key)), false, 'no chunk read')
  // Just under the bound it still answers its newest part.
  const under = Buffer.from(text.slice(0, text.lastIndexOf('\n', 1024 * 1024 - 1) + 1))
  assert.ok(under.length <= 1024 * 1024)
  assertNewestPart(await readMirrorWakeText((await mirrorStorage({ files: [[HANDOFF_PATH, under]] })).storage, { path: HANDOFF_PATH, seedId: SEED }), under)
  const f = await fixture(t, { ms: await mirrorStorage({ files: [[HANDOFF_PATH, bytes]] }), answers: [deepseekTools(readHandoff(0, 'call_00_read')), deepseekSay('Too big.')] })
  const out = await f.step()
  assert.equal(out.status, 'success')
  assert.deepEqual(out.toolRefusals, [{ tool: 'readMirrorText', code: 'cloud_wake_read_unavailable', mirrorCode: 'mirror_wake_file_limit' }])
})

test('(2nd-5) a credential refusal names the byte offset of its line (multi-byte text before it), in the answer, toolRefusals and the step row; never the text', async t => {
  const before = 'é notes ü\n'.repeat(700) + 'more 𝄞 notes\n'
  const secretLine = 'client_secret = synthetic-wake4-second\n'
  const text = before + secretLine + 'after\n'.repeat(900)
  const atByte = Buffer.byteLength(before)
  assert.ok(atByte !== before.length, 'byte offset differs from the character offset')
  const ms = await mirrorStorage({ files: [[HANDOFF_PATH, Buffer.from(text)]] })
  await assert.rejects(readMirrorWakeText(ms.storage, { path: HANDOFF_PATH, seedId: SEED }), error => error.code === 'MIRROR_WAKE_TEXT_REFUSED' && error.atByte === atByte)
  const f = await fixture(t, { ms: await mirrorStorage({ files: [[HANDOFF_PATH, Buffer.from(text)]] }),
    answers: [deepseekTools(readHandoff(0, 'call_00_read')), deepseekSay('My notes hold a refused line.')] })
  const out = await f.step({ via: 'alarm' })
  const row = { tool: 'readMirrorText', code: 'cloud_wake_read_unavailable', mirrorCode: 'mirror_wake_text_refused', atByte }
  assert.deepEqual(out.toolRefusals, [row])
  assert.deepEqual(f.toolAnswers().call_00_read, { ok: false, code: 'CLOUD_WAKE_READ_UNAVAILABLE', mirrorCode: 'MIRROR_WAKE_TEXT_REFUSED', atByte })
  assert.deepEqual((await f.wish()).steps.at(-1).toolRefusals, [row])
  for (const value of [JSON.stringify(f.requests), JSON.stringify(f.transcript()), JSON.stringify(await f.wish())]) assert.equal(value.includes('synthetic-wake4-second'), false)
  // A small file names its line too.
  await assert.rejects(readMirrorWakeText((await mirrorStorage({ files: [[HANDOFF_PATH, Buffer.from('a\nb\n-----BEGIN PRIVATE KEY-----\n')]] })).storage, { path: HANDOFF_PATH, seedId: SEED }),
    error => error.code === 'MIRROR_WAKE_TEXT_REFUSED' && error.atByte === 4)
})
