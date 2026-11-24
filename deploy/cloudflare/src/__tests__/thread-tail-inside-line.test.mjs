/**
 * `GET /_thread/tail` with a `before` inside a line. Thread sync's 3b answer (the bytes ending at
 * `before`, back to that line's start or `max`, marked partial) exists ONLY while THREAD_SYNC is exactly `on`
 * (thread-mount.mjs passes `tailInsideLine: threadSyncOn(env)`). With the switch unset or any other value the route
 * answers exactly as main an earlier commit answers: `mainTail` below is main's routeTail rule, line for line, over the whole
 * thread's bytes; every answer (status, from, to, partial, body) is compared byte for byte for every `before` and many
 * `max` values. The whole-Worker halves (the /rescue page's Check, on and off) are in thread-join-e2e.test.mjs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { bytesToBase64, handleThreadRequest } from '../thread-log.mjs'

const ORIGIN = 'https://node.example.invalid'
const ID = 'c'.repeat(64)
const encoder = new TextEncoder()
const TAIL_MAX = 262144

/** A thread whose open end holds short lines, one long line, and a torn last line (lineEnd < bytes). */
function threadBytes() {
  const parts = ['{"a":1}\n', '{"b":"two"}\n', `{"long":"${'x'.repeat(60)}"}\n`, '{"c":3}\n', '\n', '{"d":4}\n', '{"torn":']
  return encoder.encode(parts.join(''))
}
const BYTES = threadBytes()
const LINE_END = BYTES.lastIndexOf(10) + 1

/** MIRROR as the Worker half sees it: a manifest and the `range` op over one open end (nothing sealed). */
const mirror = {
  async call(op, input) {
    if (op === 'manifest') return { status: 200, body: { ok: true, thread: { id: ID, bytes: BYTES.length, sealedBytes: 0, partCount: 0, lineEnd: LINE_END } } }
    if (op === 'range') return { status: 200, body: { ok: true, sealed: [], tail: bytesToBase64(BYTES.slice(input.from, input.to)) } }
    return { status: 404, body: { ok: false, code: 'NOT_FOUND' } }
  },
}

/** Main an earlier commit's routeTail, the same steps over the thread's bytes: `{ from, to, partial }` and the answered bytes. */
function mainTail(beforeAsked, maxAsked) {
  const before = Math.min(beforeAsked ?? LINE_END, LINE_END)
  const max = Math.min(maxAsked ?? TAIL_MAX, TAIL_MAX)
  const out = (bytes, from, to, partial) => ({ bytes, from, to, partial })
  if (before === 0) return out(new Uint8Array(0), 0, 0, false)
  const readFrom = Math.max(0, before - max - 1)
  const window = BYTES.slice(readFrom, before)
  const lastNewline = window.lastIndexOf(10)
  if (lastNewline < 0) {
    const take = Math.min(max, window.length)
    return out(window.slice(window.length - take), before - take, before, true)
  }
  const end = readFrom + lastNewline + 1
  const low = Math.max(0, end - max)
  if (low === 0) return out(window.slice(0, end - readFrom), 0, end, false)
  const index = window.indexOf(10, Math.max(0, low - 1 - readFrom))
  if (index >= 0 && readFrom + index < end - 1) return out(window.slice(index + 1, end - readFrom), readFrom + index + 1, end, false)
  return out(window.slice(low - readFrom, end - readFrom), low, end, true)
}

async function tail(query, extra) {
  const url = new URL(`${ORIGIN}/_thread/tail?id=${ID}${query}`)
  const response = await handleThreadRequest({ request: new Request(url), url, mirror, ...extra })
  assert.equal(response.status, 200, query)
  return { bytes: new Uint8Array(await response.arrayBuffer()), from: Number(response.headers.get('x-thread-from')),
    to: Number(response.headers.get('x-thread-to')), partial: response.headers.get('x-thread-partial') === '1',
    headers: [...response.headers.entries()].filter(([name]) => name !== 'x-thread-from' && name !== 'x-thread-to' && name !== 'x-thread-partial') }
}

const MAXES = [1, 2, 3, 5, 7, 8, 13, 21, 40, 64, 70, 200, undefined]
const insideLine = before => before > 0 && BYTES[before - 1] !== 10

test('with the switch unset (or tailInsideLine anything but true), every tail answer equals main byte for byte, a before inside a line included', async () => {
  assert.ok(Array.from({ length: LINE_END }, (_, at) => at).filter(insideLine).length > 60, 'the fixture has many `before` values inside a line')
  let compared = 0
  for (const extra of [{}, { tailInsideLine: false }, { tailInsideLine: undefined }, { tailInsideLine: 'on' }, { tailInsideLine: 1 }]) {
    for (let before = 0; before <= BYTES.length + 2; before++) {
      for (const max of MAXES) {
        const query = `&before=${before}${max === undefined ? '' : `&max=${max}`}`
        const got = await tail(query, extra)
        const want = mainTail(before, max)
        assert.deepEqual({ from: got.from, to: got.to, partial: got.partial }, { from: want.from, to: want.to, partial: want.partial }, `${JSON.stringify(extra)} ${query}`)
        assert.deepEqual(got.bytes, want.bytes, `${JSON.stringify(extra)} ${query}`)
        assert.deepEqual(got.headers, [['cache-control', 'no-store'], ['content-type', 'application/octet-stream']])
        compared += 1
      }
    }
  }
  // No `before` at all, as main: the line end.
  for (const max of MAXES) {
    const got = await tail(max === undefined ? '' : `&max=${max}`, {})
    const want = mainTail(undefined, max)
    assert.deepEqual([got.from, got.to, got.partial, got.bytes], [want.from, want.to, want.partial, want.bytes])
  }
  assert.ok(compared > 3000)
})

test('a before inside a line, switch unset, is snapped back to its line start exactly as main does', async () => {
  // Main answers up to a `before` inside a line only when no newline is within `max` before it; every other one snaps.
  let snapped = 0
  for (let before = 1; before < LINE_END; before++) {
    const lineStart = BYTES.lastIndexOf(10, before - 1) + 1
    if (!insideLine(before) || lineStart === 0 || before - lineStart > 8) continue
    const got = await tail(`&before=${before}&max=8`, {})
    assert.equal(got.to, lineStart, `before=${before}: answered to ${got.to}`)
    snapped += 1
  }
  assert.ok(snapped > 20)
})

test('only with tailInsideLine exactly true (THREAD_SYNC on) is a before inside a line answered up to it; answers for a before at a line end are unchanged', async () => {
  let inside = 0
  for (let before = 1; before <= LINE_END; before++) {
    for (const max of MAXES) {
      const query = `&before=${before}${max === undefined ? '' : `&max=${max}`}`
      const on = await tail(query, { tailInsideLine: true })
      const want = mainTail(before, max)
      if (!insideLine(before)) {
        assert.deepEqual([on.from, on.to, on.partial, on.bytes], [want.from, want.to, want.partial, want.bytes], query)
        continue
      }
      inside += 1
      const lineStart = BYTES.lastIndexOf(10, before - 1) + 1
      const from = Math.max(lineStart, before - Math.min(max ?? TAIL_MAX, TAIL_MAX))
      assert.deepEqual([on.from, on.to, on.partial], [from, before, true], query)
      assert.deepEqual(on.bytes, BYTES.slice(from, before), query)
    }
  }
  assert.ok(inside > 600)
})
