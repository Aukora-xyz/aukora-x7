/** Honest counting, clean stops, wish notes and the slower beat. Synthetic storage, alarm and provider only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, appendWakeNote, wakeNotesForPrompt, CLOUD_WAKE_NOTE_LIMITS, CLOUD_WAKE_LIMITS, CLOUD_WAKE_PATHS } from '../head-do.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64), DAY = 'head:wake:daily:1970-01-01'
const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const tools = (...tool_calls) => ({ content: null, tool_calls })
const say = content => ({ content })

function fixture(t, options = {}) {
  const { wish, answers = [] } = options, setting = Object.hasOwn(options, 'setting') ? options.setting : '1'
  let now = 1000000, alarm = null, tail = Promise.resolve()
  let rows = new Map([['bootstrap:v1', { phase: 'complete', seedId: SEED }], ['head:current', { ballId: BALL, epoch: 2, entries: {} }]])
  if (wish) rows.set('head:wish:active', wish)
  const view = (data, timer) => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async key => data.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
    getAlarm: async () => timer.value,
    setAlarm: async value => { timer.value = value },
    deleteAlarm: async () => { timer.value = null },
  })
  const storage = {
    get: key => view(rows, { value: alarm }).get(key),
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
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
  const env = { DEEPSEEK_API_KEY: 'synthetic-provider', PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '100',
    PROVIDER_BUDGET_TOKENS: '10000000', PROVIDER_MAX_OUTPUT_TOKENS: '400', ...(setting === undefined ? {} : { WAKE_EXECUTOR_ENABLED: setting }), ...(options.env ?? {}) }
  t.mock.method(Date, 'now', () => now)
  const requests = [], requestBytes = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
    const body = JSON.parse(init.body)
    requests.push(body)
    requestBytes.push(Buffer.byteLength(init.body))
    const answer = answers.shift()
    assert.notEqual(answer, undefined, 'Unexpected provider round')
    return Response.json({ choices: [{ message: answer }] })
  })
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  t.after(() => head.wakeStore.dispose())
  head.broadcast = async () => {}
  const send = async (path, body) => {
    const response = await head.fetch(new Request('https://wake.example.invalid' + path, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(body) }))
    return { status: response.status, value: await response.json() }
  }
  const post = async (path, body) => {
    const { status, value } = await send(path, body)
    assert.equal(status, 200)
    return value
  }
  const tick = async (ms = 60000) => { now += ms; return head.alarm() }
  return { head, storage, requests, requestBytes, send, post, tick, alarmAt: () => alarm, now: () => now, wish: () => storage.get('head:wish:active'), day: () => storage.get(DAY) }
}

const running = (patch = {}) => ({ wish_id: 'w1', intent: 'Inspect continuity', acceptance: 'Record observations', status: 'running', stepsCompleted: 0, maxSteps: 6, ...patch })

async function assertEnded(f, status) {
  assert.equal(f.alarmAt(), null, 'no alarm is left')
  const wake = await f.head.wakeStore.status()
  assert.equal(wake.enabled, false)
  assert.equal(wake.scheduleStatus, 'disabled')
  const wish = await f.wish()
  assert.equal(wish.status, status)
  assert.equal(wish.wakeReleased, true)
}

test('an idle alarm with no running wish never moves the day\'s count', async t => {
  const f = fixture(t)
  await f.head.wakeStore.configure({ enabled: true, intervalMs: 60000 })
  for (let index = 0; index < 5; index++) await f.tick()
  assert.equal(await f.day(), undefined)
  assert.equal(f.requests.length, 0)
})

test('the count moves once per real step, not once per model round', async t => {
  const f = fixture(t, { wish: running(), answers: [tools(call('i', 'inspectHeadWish')), say('Observed epoch 2.')] })
  assert.equal((await f.head.executeCloudWakeStep({ now: f.now() })).status, 'success')
  assert.equal(f.requests.length, 2)
  assert.equal(await f.day(), 1)
  const wish = await f.wish()
  assert.equal(wish.stepsCompleted, 1)
  assert.deepEqual(wish.steps, [{ step: 1, at: f.now(), outcome: 'step_recorded', toolCalls: 1 }])
})

test('a step that fails before its model call does not move the count', async t => {
  const f = fixture(t, { wish: running() })
  delete f.head.env.DEEPSEEK_API_KEY
  assert.equal((await f.head.executeCloudWakeStep({ now: f.now() })).reason, 'provider_unavailable')
  assert.equal(await f.day(), undefined)
})

test('end path: its steps used up clears the alarm, and later alarms change nothing', async t => {
  const f = fixture(t, { answers: [say('one'), say('two')] })
  await f.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity', maxSteps: 2 })
  assert.notEqual(f.alarmAt(), null)
  await f.tick()
  assert.notEqual(f.alarmAt(), null)
  await f.tick()
  await assertEnded(f, 'exhausted')
  assert.equal(await f.day(), 2)
  await f.tick(); await f.tick()
  assert.equal(f.alarmAt(), null)
  assert.equal(await f.day(), 2)
  assert.equal(f.requests.length, 2)
})

test('end path: an exhausted wish left armed by an older build clears on its next alarm without counting', async t => {
  const f = fixture(t, { wish: running({ stepsCompleted: 6, status: 'exhausted' }) })
  await f.head.wakeStore.configure({ enabled: true, intervalMs: 60000 })
  const result = await f.tick()
  assert.equal(result.skipped, 'wish_ended')
  await assertEnded(f, 'exhausted')
  assert.equal(await f.day(), undefined)
  assert.equal(f.requests.length, 0)
})

test('end path: done (a wish no longer running) clears the alarm', async t => {
  const f = fixture(t, { wish: running({ status: 'completed' }) })
  await f.head.wakeStore.configure({ enabled: true, intervalMs: 60000 })
  await f.tick()
  await assertEnded(f, 'completed')
  assert.equal(await f.day(), undefined)
})

test('end path: stopped clears the alarm and does not count', async t => {
  const f = fixture(t)
  await f.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity' })
  await f.post('/_head/transcript', { action: 'wish_stop' })
  assert.equal(f.alarmAt(), null)
  await f.tick()
  await assertEnded(f, 'stopped')
  assert.equal(await f.day(), undefined)
  assert.equal(f.requests.length, 0)
})

test('end path: the day\'s steps used up ends the wish and clears the alarm', async t => {
  const f = fixture(t, { answers: [say('the last step of the day')] })
  await f.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity' })
  await f.storage.put(DAY, 47)
  await f.tick()
  assert.equal(await f.day(), 48)
  await assertEnded(f, 'day_limit')
  assert.equal(f.requests.length, 1)
  const g = fixture(t)
  await g.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity' })
  await g.storage.put(DAY, 48)
  await g.tick()
  assert.equal(await g.day(), 48)
  await assertEnded(g, 'day_limit')
  assert.equal(g.requests.length, 0)
})

test('end path: a refused wish clears the alarm with no model call and no count', async t => {
  const f = fixture(t)
  await f.post('/_head/transcript', { action: 'wish_create', intent: 'password=synthetic-value' })
  await f.tick()
  await assertEnded(f, 'refused')
  assert.equal(await f.day(), undefined)
  assert.equal(f.requests.length, 0)
})

test('end path: a tab wish_step that uses the last step clears the alarm', async t => {
  const f = fixture(t, { answers: [say('only step')] })
  await f.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity', maxSteps: 1 })
  assert.equal((await f.post('/_head/transcript', { action: 'wish_step' })).ok, true)
  await assertEnded(f, 'exhausted')
  assert.equal(await f.day(), 1)
})

test('notes: append, and the 33rd note, a 2 KiB + 1 note and the 32 KiB total are refused with closed codes', () => {
  let wish = running()
  for (let index = 0; index < 32; index++) {
    const added = appendWakeNote(wish, `note ${index}`, { step: 1, at: 1 })
    assert.equal(added.ok, true)
    wish = added.wish
  }
  assert.equal(wish.notes.length, 32)
  assert.deepEqual(appendWakeNote(wish, 'one more', { step: 1, at: 1 }), { ok: false, code: 'WAKE_NOTES_FULL' })
  assert.deepEqual(appendWakeNote(running(), 'x'.repeat(CLOUD_WAKE_NOTE_LIMITS.noteBytes + 1), { step: 1, at: 1 }), { ok: false, code: 'WAKE_NOTE_TOO_LARGE' })
  assert.equal(appendWakeNote(running(), 'x'.repeat(CLOUD_WAKE_NOTE_LIMITS.noteBytes), { step: 1, at: 1 }).ok, true)
  let full = running()
  for (let index = 0; index < 16; index++) full = appendWakeNote(full, String(index % 10).repeat(2048), { step: 1, at: 1 }).wish
  assert.equal(full.notes.length, 16)
  assert.deepEqual(appendWakeNote(full, 'y', { step: 1, at: 1 }), { ok: false, code: 'WAKE_NOTES_TOTAL_FULL' })
  for (const bad of ['', '   ', 7, null]) assert.equal(appendWakeNote(running(), bad, { step: 1, at: 1 }).code, 'WAKE_NOTE_INVALID')
  assert.equal(appendWakeNote(null, 'x', { step: 1, at: 1 }).code, 'WAKE_NOTE_NO_WISH')
})

test('notes: secret shapes and configured secret values are refused before anything is stored', () => {
  const shapes = ['password=synthetic-value', 'Bearer synthetic-value', 'gh' + 'p_' + 'A'.repeat(36), 'AK' + 'IA' + 'B'.repeat(16), '-----BEGIN ' + 'PRIVATE KEY-----']
  for (const text of shapes) assert.deepEqual(appendWakeNote(running(), text, { step: 1, at: 1 }), { ok: false, code: 'WAKE_NOTE_REFUSED' }, text)
  assert.equal(appendWakeNote(running(), 'it was synthetic-configured-value', { step: 1, at: 1, env: { SOME_API_KEY: 'synthetic-configured-value' } }).code, 'WAKE_NOTE_REFUSED')
})

test('notes: the newest that fit ride in the prompt and the step is told how many were left out', () => {
  const notes = Array.from({ length: 16 }, (_, index) => ({ step: index + 1, at: 1, text: String(index % 10).repeat(2048) }))
  const carried = wakeNotesForPrompt(notes)
  assert.ok(carried.notes.length > 0 && carried.notes.length < 16)
  assert.equal(carried.omitted, 16 - carried.notes.length)
  assert.equal(carried.notes.at(-1).step, 16)
  assert.ok(Buffer.byteLength(JSON.stringify(carried.notes)) <= CLOUD_WAKE_NOTE_LIMITS.promptBytes)
  assert.deepEqual(wakeNotesForPrompt([{ step: 1, at: 1, text: 'a' }]), { notes: [{ step: 1, text: 'a' }], omitted: 0 })
})

test('notes: a model note with a secret shape is refused to the model and never stored', async t => {
  const secret = 'gh' + 'p_' + 'C'.repeat(36)
  const f = fixture(t, { wish: running(), answers: [tools(call('n', 'wake_note', { text: `found ${secret}` })), say('Done looking.')] })
  assert.equal((await f.head.executeCloudWakeStep({ now: f.now() })).status, 'success')
  const toolMessage = f.requests[1].messages.find(message => message.role === 'tool')
  assert.equal(JSON.parse(toolMessage.content).code, 'WAKE_NOTE_REFUSED')
  assert.deepEqual((await f.wish()).notes ?? [], [])
})

test('notes: an over-full prompt says how many older notes were left out', async t => {
  const notes = Array.from({ length: 16 }, (_, index) => ({ step: 1, at: 1, text: String(index % 10).repeat(2048) }))
  const f = fixture(t, { wish: running({ notes }), answers: [say('read them')] })
  assert.equal((await f.head.executeCloudWakeStep({ now: f.now() })).status, 'success')
  const user = JSON.parse(f.requests[0].messages.find(message => message.role === 'user').content)
  assert.ok(user.notesOmitted > 0)
  assert.equal(user.notes.length + user.notesOmitted, 16)
  assert.match(user.notesInstruction, new RegExp(`${user.notesOmitted} older note\\(s\\) did not fit`))
})

test('everySeconds: 60 by default, 600 honoured, out of range refused', async t => {
  const f = fixture(t)
  const created = await f.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity' })
  assert.equal(created.wish.everySeconds, 60)
  assert.equal((await f.head.wakeStore.status()).intervalMs, 60000)
  assert.equal(f.alarmAt(), f.now() + 60000)
  await f.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity', everySeconds: 600 })
  assert.equal((await f.head.wakeStore.status()).intervalMs, 600000)
  assert.equal(f.alarmAt(), f.now() + 600000)
  assert.equal((await f.wish()).everySeconds, 600)
  for (const everySeconds of [59, 3601, 60.5, '600', null]) {
    const before = await f.wish()
    const refused = await f.send('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity', everySeconds })
    assert.equal(refused.status, 400)
    assert.equal(refused.value.code, 'WISH_EVERY_SECONDS_INVALID')
    assert.deepEqual(await f.wish(), before)
  }
})

test('switch unset: no model call, no note, no count, and status still answers', async t => {
  const f = fixture(t, { setting: undefined })
  await f.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity', maxSteps: 3 })
  for (let index = 0; index < 3; index++) await f.tick()
  assert.equal((await f.post('/_head/transcript', { action: 'wish_step' })).probeStatus, 'blocked')
  assert.equal(f.requests.length, 0)
  assert.equal(await f.day(), undefined)
  const status = await f.post('/_head/transcript', { action: 'wish_status' })
  assert.deepEqual(status.notes, [])
  assert.deepEqual(status.steps, [])
  assert.equal(status.wish.stepsCompleted, 0)
})

test('switch "1": a three-step wish writes a note in step 1, reads it in step 2, and ends with no alarm armed', async t => {
  const f = fixture(t, { answers: [
    tools(call('n1', 'wake_note', { text: 'HANDOFF.md names the next job: wire the notes.' })), say('Step one noted.'),
    say('Step two read the note.'),
    tools(call('n3', 'wake_note', { text: 'Step three: nothing more to look at.' })), say('Step three done.'),
  ] })
  await f.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity', maxSteps: 3 })
  await f.tick()
  assert.equal((await f.wish()).notes.length, 1)
  await f.tick()
  const second = JSON.parse(f.requests[2].messages.find(message => message.role === 'user').content)
  assert.deepEqual(second.notes, [{ step: 1, text: 'HANDOFF.md names the next job: wire the notes.' }])
  assert.equal(second.notesOmitted, 0)
  await f.tick()
  await assertEnded(f, 'exhausted')
  assert.equal(await f.day(), 3)
  assert.equal(f.requests.length, 5)
  const status = await f.post('/_head/transcript', { action: 'wish_status' })
  assert.deepEqual(status.notes.map(note => [note.step, note.text]), [[1, 'HANDOFF.md names the next job: wire the notes.'], [3, 'Step three: nothing more to look at.']])
  assert.deepEqual(status.steps.map(step => [step.step, step.outcome]), [[1, 'no_tool_evidence'], [2, 'no_tool_evidence'], [3, 'no_tool_evidence']])
  assert.ok(status.steps.every(step => Number.isSafeInteger(step.at)))
  await f.tick()
  assert.equal(f.alarmAt(), null)
  assert.equal(f.requests.length, 5)
})

// Notes take only the room the rest of the request leaves, so a step never goes over the bound for them.
test('notes never push a step over the request bound: three rounds, full notes, maximum intent and acceptance, six 4 KiB reads', async t => {
  const notes = Array.from({ length: 16 }, (_, index) => ({ step: index + 1, at: 1, text: String(index % 10).repeat(2048) }))
  const text = 'x'.repeat(CLOUD_WAKE_LIMITS.textBytes)
  const MIRROR = { idFromName: name => name, get: () => ({ fetch: async request => {
    const { path } = await request.json()
    return Response.json({ ok: true, path, text, revision: 1 })
  } }) }
  const reads = prefix => CLOUD_WAKE_PATHS.map((path, index) => call(`${prefix}${index}`, 'readMirrorText', { path }))
  const f = fixture(t, { wish: running({ intent: 'i'.repeat(4000), acceptance: 'a'.repeat(4000), notes }), env: { MIRROR },
    answers: [tools(...reads('r')), tools(...reads('s')), say('Read all six.')] })
  const out = await f.head.executeCloudWakeStep({ now: f.now() })
  assert.equal(out.status, 'success')
  assert.equal(out.toolCalls, 6)
  assert.equal(f.requests.length, 3)
  for (const size of f.requestBytes) assert.ok(size <= CLOUD_WAKE_LIMITS.requestBytes, `request of ${size} bytes`)
  const results = f.requests[2].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
  assert.equal(results.length, 6)
  assert.ok(results.every(result => result.ok === true && result.text === text))
  for (const body of f.requests) {
    const user = JSON.parse(body.messages.find(message => message.role === 'user').content)
    assert.ok(user.notes.length > 0, 'the newest notes still ride')
    assert.equal(user.notes.at(-1).step, 16)
    assert.equal(user.notes.length + user.notesOmitted, 16)
    if (user.notesOmitted) assert.match(user.notesInstruction, new RegExp(`${user.notesOmitted} older note\\(s\\) did not fit`))
  }
  const carriedIn = body => JSON.parse(body.messages.find(message => message.role === 'user').content).notes.length
  assert.ok(carriedIn(f.requests[2]) < carriedIn(f.requests[0]), 'the later round gave up older notes to stay inside the bound')
  assert.equal(await f.day(), 1)
  assert.equal((await f.wish()).stepsCompleted, 1)
})

// A stopped wish has released the wake, so the owner's later switch stays his.
test('a stopped wish never turns off a wake timer the owner switched on afterwards', async t => {
  const f = fixture(t)
  await f.post('/_head/transcript', { action: 'wish_create', intent: 'Inspect continuity' })
  const stopped = await f.post('/_head/transcript', { action: 'wish_stop' })
  assert.equal(stopped.wish.wakeReleased, true)
  assert.equal(stopped.wish.ended_at, f.now())
  assert.equal(f.alarmAt(), null)
  await f.post('/_host/wake', { action: 'configure', enabled: true, intervalMs: 60000 })
  await f.tick(); await f.tick()
  const wake = await f.head.wakeStore.status()
  assert.equal(wake.enabled, true)
  assert.notEqual(f.alarmAt(), null)
  assert.equal(await f.day(), undefined)
  assert.equal(f.requests.length, 0)
})

// Notes pass the edge's outward-write screen (cloud-brokers.mjs), not a narrower one.
test('notes: the outward-write screen refuses Cloudflare key shapes and seedHex before anything is stored', async t => {
  for (const text of ['cf' + 'ut_' + 'A'.repeat(24), 'cf' + 'k_' + 'B'.repeat(24), 'cf' + 'at_' + 'C'.repeat(24), '{"seed' + 'Hex": "00"}', "found 'privateKeyJwk': {}"]) {
    assert.deepEqual(appendWakeNote(running(), text, { step: 1, at: 1 }), { ok: false, code: 'WAKE_NOTE_REFUSED' }, text)
  }
  const shape = 'cf' + 'ut_' + 'D'.repeat(24)
  const f = fixture(t, { wish: running(), answers: [tools(call('n', 'wake_note', { text: `read ${shape}` })), say('Done.')] })
  assert.equal((await f.head.executeCloudWakeStep({ now: f.now() })).status, 'success')
  assert.equal(JSON.parse(f.requests[1].messages.find(message => message.role === 'tool').content).code, 'WAKE_NOTE_REFUSED')
  assert.deepEqual((await f.wish()).notes ?? [], [])
})
