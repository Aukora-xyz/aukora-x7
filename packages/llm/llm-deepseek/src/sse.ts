/** SSE framing delegated to eventsource-parser; JSON errors remain provider failures. */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { object } from './replay.ts'
import { providerError } from './transport.ts'

/** Decode complete SSE frames without treating an unterminated tail as an event.
 * @param body - provider response bytes.
 * @param activity - pulse the idle watchdog for events and heartbeat comments.
 * @returns JSON events, including message_stop; the translator owns completion.
 */
/**
 * Aukora X5 (her subagent stall): under load DeepSeek keeps a request queued and sends keep-alive comments
 * until generation starts, for up to 30 minutes, so the idle watchdog alone let a queued call wait that long and a
 * subagent never settled. Heartbeats still keep the read alive, but the first real event must arrive within this.
 */
export const FIRST_EVENT_TIMEOUT_MS = 300_000

export async function* parseSse(body: ReadableStream<BufferSource>, activity: () => void, firstEventMs = FIRST_EVENT_TIMEOUT_MS): AsyncGenerator<Record<string, unknown>> {
  const events = body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: activity }))
  // Aukora X5 r14 (GPT 7): own the reader. Racing an async iterator's next() and then awaiting its return() in finally
  // waited on the still-pending read, so a body that sent nothing at all hung forever. On the deadline the reader is
  // cancelled first (which settles the pending read and cancels the body), then TIMEOUT is thrown.
  const reader = events.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const queued = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reader.cancel().catch(() => {})
      reject(new LlmError(`DeepSeek sent no first event within ${Math.round(firstEventMs / 1000)} s (queued upstream, or the stream stalled)`, 'TIMEOUT'))
    }, firstEventMs)
  })
  queued.catch(() => {})
  let started = false
  try {
    for (;;) {
      const next = started ? await reader.read() : await Promise.race([reader.read(), queued])
      if (timedOut) await queued
      if (next.done) return
      const frame = next.value
      activity()
      let raw: unknown
      try { raw = JSON.parse(frame.data) } catch (_invalidSseJson) {
        throw new LlmError('DeepSeek Messages SSE contains invalid JSON', 'MALFORMED_RESPONSE')
      }
      const event = object(raw)
      if (typeof event.type !== 'string' || (frame.event !== undefined && frame.event !== event.type)) {
        throw new LlmError('DeepSeek Messages SSE event type mismatch', 'MALFORMED_RESPONSE')
      }
      if (event.type === 'error') throw providerError(event, undefined)
      if (!started && event.type !== 'ping') { started = true; clearTimeout(timer) }
      yield event
    }
  } finally {
    clearTimeout(timer)
    // cancel() never waits on a pending read the way an iterator's return() does; it settles that read instead.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
