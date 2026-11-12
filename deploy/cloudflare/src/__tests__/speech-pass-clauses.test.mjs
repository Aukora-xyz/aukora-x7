/** Stack frames cannot cross the grounded speech boundary, including inline renderer input. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { handleEdgeVoiceRequest, validateSpeakableClause } from '../voice-director.mjs'

const origin = 'https://speech.example.invalid'
function invoke(text) {
  const request = new Request(origin + '/_host/voice', { method: 'POST', body: JSON.stringify({ action: 'validate_clause', clause: { turnId: 'turn-1', text } }) })
  return handleEdgeVoiceRequest({ request, url: new URL(request.url), env: {} })
}

test('inline JavaScript, Python and Rust traces are raw payload refusals', async () => {
  for (const text of [
    'Error at fn(file.js:10:2)',
    'The failure was Error: unavailable at fn (file.js:10:2).',
    'Error: unavailable\n    at async run (/srv/worker.mjs:40:2)',
    'Failure at file.js:10:2',
    'Failure at async file:///srv/worker.mjs:40:2',
    'Failure at node:internal/process/task_queues:105:5',
    'Traceback (most recent call last):\n  File "worker.py", line 12, in main\nValueError: failed',
    "Failure in File 'worker.py', line 12, in main",
    "thread 'main' panicked at src/main.rs:10:2: failed",
    'thread "worker" panicked at src/main.rs:10:2',
    'stack backtrace:\n   0: std::panicking::begin_panic',
    '    1: 0x1234abcd - std::panicking::begin_panic',
    'Failure at src/main.rs:10:2',
  ]) {
    assert.throws(() => validateSpeakableClause({ turnId: 'turn-1', text }), { code: 'VOICE_CLAUSE_RAW_PAYLOAD_REFUSED', status: 400 }, text)
    await assert.rejects(invoke(text), { code: 'VOICE_CLAUSE_RAW_PAYLOAD_REFUSED', status: 400 }, text)
  }
})

test('normal prose, clock times and high-level failure summaries remain speakable', async () => {
  for (const text of [
    'I will meet you at 10:30 tomorrow.',
    'The meeting starts at 10:30:15 and ends at noon.',
    'The JavaScript request failed, so I stopped safely.',
    'Python reported a missing file. I can check the path next.',
    'The Rust worker panicked during startup. No changes were committed.',
    'The stack trace points to a network timeout.',
    'I looked at the report (the first draft) and found no errors.',
    'At the next step, I will verify the result.',
  ]) {
    assert.equal(validateSpeakableClause({ turnId: 'turn-1', text }).text, text)
    const response = await invoke(text)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).directive.text, text)
  }
})
