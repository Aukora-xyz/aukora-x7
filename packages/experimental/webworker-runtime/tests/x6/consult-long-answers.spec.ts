/**
 * `x6_consult` answers
 * are no longer cut at a few hundred words. Each target streams from the provider through the edge door; the default cap
 * is 16000 for Anthropic (its thinking counts inside the cap) and 8000 elsewhere, up to 64000; a cut answer keeps its
 * text, says `truncated: true` and how to get the rest; a stream that dies is a failure, never a partial answer marked whole.
 */
import { describe, expect, it } from 'vitest'
import { consultProviders, consultProviderOutputLimit, CONSULT_LIMITS } from '../../src/x6/ball-loader.ts'

const ORIGIN = 'https://x61.example.invalid'
const encoder = new TextEncoder()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sse = (chunks: ReadonlyArray<string | Uint8Array>, end: 'close' | 'error' = 'close') => {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++] as string | Uint8Array
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
        return
      }
      if (end === 'error') controller.error(new Error('connection reset'))
      else controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const anthropicStream = (texts: readonly string[], stop: string | null, { outputTokens = 0, withStop = true } = {}) => [
  event('message_start', { message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 12, output_tokens: 1 } } }),
  event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Let me weigh this.' } }),
  event('content_block_stop', { index: 0 }),
  event('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  ': keep-alive comment\n\n',
  event('ping', {}),
  ...texts.map(text => event('content_block_delta', { index: 1, delta: { type: 'text_delta', text } })),
  event('content_block_stop', { index: 1 }),
  ...(stop === null ? [] : [event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } })]),
  ...(withStop ? [event('message_stop', {})] : []),
]
type Call = { url: string; body: Record<string, unknown> }
const recorder = (reply: (call: Call, index: number) => Response) => {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call = { url, body: JSON.parse(init?.body as string) as Record<string, unknown> }
    calls.push(call)
    return reply(call, calls.length - 1)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('x6_consult long answers', () => {
  it('an Anthropic stream of about 40,000 tokens comes back whole: truncated false, its stop reason and usage', async () => {
    // 1,600 deltas of 100 characters: 160,000 characters, about 40,000 tokens of answer.
    const pieces = Array.from({ length: 1600 }, (_value, index) => `${String(index).padStart(5, '0')} ${'x'.repeat(93)}\n`)
    const { calls, fetchImpl } = recorder(() => sse(anthropicStream(pieces, 'end_turn', { outputTokens: 40_000 })))
    const result = await consultProviders({ model: 'Fable 5.2', prompt: 'Write it all out.' }, { origin: ORIGIN, fetchImpl })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${ORIGIN}/door/anthropic/v1/messages`)
    expect(calls[0]?.body).toMatchObject({ model: 'claude-fable-5-2', max_tokens: 16_000, stream: true })
    const [answer] = result.answers ?? []
    expect(result.ok).toBe(true)
    expect(answer).toMatchObject({ ok: true, truncated: false, stopReason: 'end_turn', maxTokens: 16_000, code: null, next: null,
      usage: { inputTokens: 12, outputTokens: 40_000 } })
    expect(answer?.text).toBe(pieces.join(''))
    expect(answer?.text).toHaveLength(160_000)
  })

  it('a stop for length keeps the text so far, says truncated true, and says how to get the rest', async () => {
    const { fetchImpl } = recorder(() => sse(anthropicStream(['The first half ', 'of the answ'], 'max_tokens', { outputTokens: 16_000 })))
    const result = await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p' }, { origin: ORIGIN, fetchImpl })
    expect(result.answers?.[0]).toEqual(expect.objectContaining({ ok: true, text: 'The first half of the answ', truncated: true, stopReason: 'max_tokens',
      next: 'The provider stopped at maxTokens 16000 (thinking included); ask again with a larger maxTokens, up to 64000.' }))
    const atCeiling = await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p', maxTokens: 64_000 }, { origin: ORIGIN, fetchImpl })
    expect(atCeiling.answers?.[0]).toEqual(expect.objectContaining({ ok: true, truncated: true, maxTokens: 64_000,
      next: 'The provider stopped at the 64000 ceiling; ask for the rest in a follow-up consult.' }))
    // Thinking that spends the whole cap before a word is said so, with the same way forward.
    const { fetchImpl: silent } = recorder(() => sse(anthropicStream([], 'max_tokens')))
    expect((await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p' }, { origin: ORIGIN, fetchImpl: silent })).answers?.[0])
      .toEqual(expect.objectContaining({ ok: false, text: null, code: 'CONSULT_REASONING_EXHAUSTED_MAX_TOKENS',
        next: 'The provider stopped at maxTokens 16000 (thinking included); ask again with a larger maxTokens, up to 64000.' }))
  })

  it('defaults to 16000 for Anthropic and 8000 for every other provider; 64000 is the ceiling and 64001 is refused with a sentence', async () => {
    const { calls, fetchImpl } = recorder(call => call.url.endsWith('/v1/messages')
      ? json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
      : json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }))
    const council = await consultProviders({ prompt: 'p', targets: [
      { provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: 'openrouter', model: 'moonshotai/kimi-k3.1-pro' },
      { provider: 'deepseek', model: 'deepseek-chat' }, { provider: 'openai', model: 'o-model' },
    ] }, { origin: ORIGIN, fetchImpl })
    expect(council.answers?.map(answer => [answer.provider, answer.ok, answer.maxTokens, answer.truncated])).toEqual([
      ['anthropic', true, 16_000, false], ['openrouter', true, 8_000, false], ['deepseek', true, 8_000, false], ['openai', true, 8_000, false],
    ])
    expect(calls.map(call => [call.body.max_tokens, call.body.max_completion_tokens, call.body.stream])).toEqual([
      [16_000, undefined, true], [8_000, undefined, true], [8_000, undefined, true], [undefined, 8_000, true],
    ])
    calls.length = 0
    expect((await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p', maxTokens: 64_000 }, { origin: ORIGIN, fetchImpl })).ok).toBe(true)
    expect(calls[0]?.body.max_tokens).toBe(64_000)
    expect(await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p', maxTokens: 64_001 }, { origin: ORIGIN, fetchImpl })).toEqual({
      ok: false, code: 'CONSULT_MAX_TOKENS_INVALID',
      reason: 'maxTokens is a whole number from 1 to 64000 per target (the ceiling); leave it out for 16000 on anthropic and 8000 elsewhere.' })
    expect(calls).toHaveLength(1)
    expect([CONSULT_LIMITS.defaultTimeoutMs, CONSULT_LIMITS.timeoutMs]).toEqual([180_000, 600_000])
    expect((await consultProviders({ provider: 'deepseek', model: 'deepseek-chat', prompt: 'p', timeoutMs: 600_000 }, { origin: ORIGIN, fetchImpl })).ok).toBe(true)
    expect(await consultProviders({ provider: 'deepseek', model: 'deepseek-chat', prompt: 'p', timeoutMs: 600_001 }, { origin: ORIGIN, fetchImpl }))
      .toMatchObject({ ok: false, code: 'CONSULT_TIMEOUT_INVALID' })
  })

  it('a stream that dies mid-way is a provider failure, never a partial answer marked complete', async () => {
    const unfinished = anthropicStream(['Half of it'], null, { withStop: false })
    for (const [label, reply, code] of [
      ['closed before message_stop', () => sse(unfinished), 'CONSULT_STREAM_INTERRUPTED'],
      ['connection reset', () => sse(unfinished, 'error'), 'CONSULT_STREAM_INTERRUPTED'],
      ['provider error event', () => sse([...unfinished, event('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })]), 'CONSULT_PROVIDER_STREAM_ERROR'],
      ['openai-wire stream without finish or DONE', () => sse([`data: ${JSON.stringify({ choices: [{ delta: { content: 'Half' } }] })}\n\n`]), 'CONSULT_STREAM_INTERRUPTED'],
      ['unreadable event', () => sse(['data: {not json\n\n']), 'CONSULT_STREAM_UNREADABLE'],
    ] as const) {
      const { fetchImpl } = recorder(reply)
      const provider = label.startsWith('openai') ? 'openrouter' : 'anthropic'
      const result = await consultProviders({ provider, model: provider === 'anthropic' ? 'claude-opus-5-5' : 'x/y', prompt: 'p' }, { origin: ORIGIN, fetchImpl })
      const [first] = result.answers ?? []
      expect([label, result.ok, first?.ok, first?.text, first?.truncated, first?.code]).toEqual([label, false, false, null, false, code])
    }
    const { fetchImpl } = recorder(() => sse([...unfinished, event('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })]))
    expect((await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p' }, { origin: ORIGIN, fetchImpl })).answers?.[0]?.detail)
      .toBe('overloaded_error: Overloaded')
  })

  it('the byte bound: past 128 MiB of raw stream the read stops and cuts; past 512 KiB of answer text the answer is cut and says so', async () => {
    // The raw bytes are a backstop that CUTS (consult_stream_cap), no longer a failure that
    // throws the text away; framing no longer counts toward the answer's bound (streamChars).
    expect([CONSULT_LIMITS.streamBytes, CONSULT_LIMITS.answerChars, CONSULT_LIMITS.streamChars, CONSULT_LIMITS.streamEventChars])
      .toEqual([128 * 1024 * 1024, 512 * 1024, 2 * 1024 * 1024, 1024 * 1024])
    const mebibyteOfComments = encoder.encode(`: ${'p'.repeat(512 * 1024 - 3)}\n`.repeat(2))
    let pulled = 0
    const flood = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Said before the flood.' } }))) },
      pull(controller) { pulled += 1; controller.enqueue(mebibyteOfComments) },
    })
    const { fetchImpl } = recorder(() => new Response(flood, { headers: { 'content-type': 'text/event-stream' } }))
    const flooded = await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p' }, { origin: ORIGIN, fetchImpl })
    // Review (ordered): the raw backstop says it was framing, never that a long answer needs "the rest".
    expect(flooded.answers?.[0]).toEqual(expect.objectContaining({ ok: true, text: 'Said before the flood.', truncated: true, stopReason: 'consult_stream_cap',
      code: null, next: 'The raw stream passed this page\'s backstop (134217728 bytes, event framing included) and was cut here; almost all of it was framing, not answer. Ask again; ask for the rest only if the text ends mid-thought.' }))
    expect(pulled).toBeGreaterThanOrEqual(128)
    expect(pulled).toBeLessThanOrEqual(130)

    let more = 0
    const endless = new ReadableStream<Uint8Array>({
      start(controller) { for (const part of anthropicStream([], null, { withStop: false })) controller.enqueue(encoder.encode(part)) },
      pull(controller) { more += 1; controller.enqueue(encoder.encode(event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'y'.repeat(64 * 1024) } }))) },
    })
    const { fetchImpl: long } = recorder(() => new Response(endless, { headers: { 'content-type': 'text/event-stream' } }))
    const cut = await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p' }, { origin: ORIGIN, fetchImpl: long })
    expect(cut.answers?.[0]).toEqual(expect.objectContaining({ ok: true, truncated: true, stopReason: 'consult_answer_cap',
      next: 'The answer passed the 524288-character cap here; ask for it in parts.' }))
    expect(cut.answers?.[0]?.text).toHaveLength(CONSULT_LIMITS.answerChars)
    expect(more).toBeLessThanOrEqual(10)
  })

  it('reads an OpenAI-style stream split anywhere, with CRLF, reasoning, a finish reason, usage and [DONE]', async () => {
    const text = [
      ': OPENROUTER PROCESSING\r\n\r\n',
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', reasoning: 'thinking first' } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Kimi ' } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'answers ✓' } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } })}\r\n\r\n`,
      'data: [DONE]\r\n\r\n',
    ].join('')
    const bytes = encoder.encode(text)
    // Split into 7-byte pieces: lines, events and the multi-byte check mark all straddle chunk edges.
    const pieces = Array.from({ length: Math.ceil(bytes.length / 7) }, (_value, index) => bytes.slice(index * 7, index * 7 + 7))
    const { calls, fetchImpl } = recorder(() => sse(pieces))
    const result = await consultProviders({ model: 'Kimi K3.1', prompt: 'p' }, { origin: ORIGIN, fetchImpl })
    expect(calls[0]?.url).toBe(`${ORIGIN}/door/openrouter/v1/chat/completions`)
    expect(result.answers?.[0]).toEqual(expect.objectContaining({ ok: true, text: 'Kimi answers ✓', truncated: false, stopReason: 'stop',
      maxTokens: 8_000, usage: { inputTokens: 9, outputTokens: 4 }, next: null }))
    const { fetchImpl: cutByLength } = recorder(() => sse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Cut' }, finish_reason: 'length' }] })}\n\n`, 'data: [DONE]\n\n',
    ]))
    expect((await consultProviders({ model: 'GPT Astra', prompt: 'p', maxTokens: 2000 }, { origin: ORIGIN, fetchImpl: cutByLength })).answers?.[0])
      .toEqual(expect.objectContaining({ ok: true, text: 'Cut', truncated: true, stopReason: 'length',
        next: 'The provider stopped at maxTokens 2000 (thinking included); ask again with a larger maxTokens, up to 64000.' }))
  })

  it('a provider that refuses the cap is asked ONCE more with the largest limit its refusal names; never again', async () => {
    const tooBig = { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-5-5' } }
    const { calls, fetchImpl } = recorder((_call, index) => index === 0 ? json(tooBig, 400) : sse(anthropicStream(['fits'], 'end_turn')))
    const retried = await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p', maxTokens: 64_000 }, { origin: ORIGIN, fetchImpl })
    expect(calls.map(call => call.body.max_tokens)).toEqual([64_000, 32_000])
    expect(retried.answers?.[0]).toMatchObject({ ok: true, text: 'fits', maxTokens: 32_000, truncated: false })

    const { calls: twice, fetchImpl: refusesAgain } = recorder(() => json(tooBig, 400))
    const refused = await consultProviders({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'p', maxTokens: 64_000 }, { origin: ORIGIN, fetchImpl: refusesAgain })
    expect(twice).toHaveLength(2)
    expect(refused.answers?.[0]).toMatchObject({ ok: false, status: 400, code: 'HTTP_400', maxTokens: 32_000 })

    const { calls: once, fetchImpl: otherRefusal } = recorder(() => json({ error: { type: 'invalid_request_error', message: 'messages: at least one message is required' } }, 400))
    expect((await consultProviders({ provider: 'deepseek', model: 'deepseek-chat', prompt: 'p' }, { origin: ORIGIN, fetchImpl: otherRefusal })).answers?.[0])
      .toMatchObject({ ok: false, code: 'HTTP_400', detail: 'invalid_request_error: messages: at least one message is required' })
    expect(once).toHaveLength(1)

    expect(consultProviderOutputLimit({ error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]' } }, 8_000)).toBe(null)
    expect(consultProviderOutputLimit({ error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]' } }, 16_000)).toBe(8192)
    expect(consultProviderOutputLimit({ error: { message: 'max_tokens is too large: 64000. This model supports at most 16,384 completion tokens, whereas you provided 64000.' } }, 64_000)).toBe(16_384)
    expect(consultProviderOutputLimit({ code: 'PROVIDER_OUTPUT_LIMIT_REQUIRED' }, 64_000)).toBe(null)
  })
})

/** One OpenRouter chat chunk, framed the way OpenRouter frames it (about 250-350 bytes per token). */
const openRouterChunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({
  id: 'gen-1731500000-AbCdEfGhIjKlMnOpQrSt', provider: 'Moonshot AI', model: 'moonshotai/kimi-k3.1-pro', object: 'chat.completion.chunk',
  created: 1731500000, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finish, native_finish_reason: finish, logprobs: null }],
})}\n\n`
/** A stream of `events` (strings), enqueued in batches of `per` so a long stream is not one pull per event. */
const batched = (events: readonly string[], per = 1000) => sse(Array.from({ length: Math.ceil(events.length / per) },
  (_value, index) => events.slice(index * per, index * per + per).join('')))

describe('x6_consult long answers are cut, never lost', () => {
  it('an OpenRouter-framed stream at the 64,000 ceiling (over 16 MiB of framing) comes back whole', async () => {
    // 16,000 thinking deltas then 48,000 answer deltas: 64,000 tokens' worth, each in its own framed chunk.
    const thinking = Array.from({ length: 16_000 }, () => openRouterChunk({ content: '', reasoning: 'hmm ' }))
    const answer = Array.from({ length: 48_000 }, (_value, index) => openRouterChunk({ content: `w${String(index % 10)}a ` }))
    const events = [': OPENROUTER PROCESSING\n\n', ...thinking, ...answer, openRouterChunk({ content: '' }, 'stop'),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 64_000 } })}\n\n`, 'data: [DONE]\n\n']
    const rawBytes = events.reduce((total, part) => total + encoder.encode(part).byteLength, 0)
    expect(rawBytes).toBeGreaterThan(16 * 1024 * 1024)
    const { fetchImpl } = recorder(() => batched(events))
    const result = await consultProviders({ model: 'Kimi K3.1 Pro', prompt: 'p', maxTokens: 64_000 }, { origin: ORIGIN, fetchImpl })
    const [first] = result.answers ?? []
    expect(first).toEqual(expect.objectContaining({ ok: true, truncated: false, stopReason: 'stop', maxTokens: 64_000, code: null, next: null,
      usage: { inputTokens: 20, outputTokens: 64_000 } }))
    expect(first?.text).toHaveLength(48_000 * 4)
    expect(first?.text?.startsWith('w0a w1a ')).toBe(true)
  })

  it('a stream past the text-and-thinking bound comes back cut, with the text read before it', async () => {
    // The answer starts, then thinking runs on past 2 Mi characters (OpenRouter interleaves them).
    const said = Array.from({ length: 100 }, (_value, index) => openRouterChunk({ content: `part ${String(index)}. ` }))
    const flood = Array.from({ length: 200 }, () => openRouterChunk({ content: '', reasoning: 'r'.repeat(32 * 1024) }))
    const after = [openRouterChunk({ content: 'never read' }), openRouterChunk({ content: '' }, 'stop'), 'data: [DONE]\n\n']
    let pulled = 0
    const { fetchImpl } = recorder(() => {
      const response = batched([...said, ...flood, ...after], 10)
      const reader = response.body!.getReader()
      return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        pulled += 1
        const part = await reader.read()
        if (part.done) controller.close(); else controller.enqueue(part.value)
      } }), { headers: response.headers })
    })
    const result = await consultProviders({ model: 'GPT Astra', prompt: 'p' }, { origin: ORIGIN, fetchImpl })
    const expected = Array.from({ length: 100 }, (_value, index) => `part ${String(index)}. `).join('')
    expect(result.answers?.[0]).toEqual(expect.objectContaining({ ok: true, text: expected, truncated: true, stopReason: 'consult_stream_cap', code: null,
      next: 'The stream passed this page\'s bound (2097152 characters of answer and thinking) and was cut here; ask for the rest in a follow-up consult, or in parts.' }))
    // The read stopped at the bound: the chunks after it were never pulled.
    expect(pulled).toBeLessThanOrEqual(20)
  })

  it('a bound reached before any answer text is a stream cut with text null; a line that never ends is cut too', async () => {
    const thinkingOnly = Array.from({ length: 70 }, () => openRouterChunk({ content: '', reasoning: 'r'.repeat(32 * 1024) }))
    const { fetchImpl } = recorder(() => batched(thinkingOnly, 10))
    expect((await consultProviders({ model: 'Kimi K3.1', prompt: 'p' }, { origin: ORIGIN, fetchImpl })).answers?.[0]).toEqual(expect.objectContaining({
      ok: false, text: null, truncated: false, stopReason: 'consult_stream_cap', code: 'CONSULT_STREAM_CAP',
      next: 'The stream passed this page\'s bound (2097152 characters of answer and thinking) and was cut here; ask for the rest in a follow-up consult, or in parts.' }))
    let more = 0
    const endless = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(`${openRouterChunk({ content: 'Kept.' })}data: {"choices":[{"delta":{"content":"`)) },
      pull(controller) { more += 1; controller.enqueue(encoder.encode('z'.repeat(256 * 1024))) },
    })
    const { fetchImpl: unending } = recorder(() => new Response(endless, { headers: { 'content-type': 'text/event-stream' } }))
    expect((await consultProviders({ model: 'Kimi K3.1', prompt: 'p' }, { origin: ORIGIN, fetchImpl: unending })).answers?.[0])
      .toEqual(expect.objectContaining({ ok: true, text: 'Kept.', truncated: true, stopReason: 'consult_stream_cap',
        next: 'The provider sent one event larger than this page reads (1048576 characters) and the stream was cut before it; the text so far is kept. Ask again; ask for the rest only if the text ends mid-thought.' }))
    expect(more).toBeLessThanOrEqual(6)
  })

  it('a stream still running when timeoutMs runs out comes back cut with its text; no text yet is a timeout; a caller cancel is a cancel', async () => {
    // Review MUST: the clock is a bound like the others. Text already read is kept; the stream is stopped and released.
    let released = 0
    const stalled = (parts: readonly string[]) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)) },
      pull() { return new Promise<void>(() => {}) },
      cancel() { released += 1 },
    }), { headers: { 'content-type': 'text/event-stream' } })
    const { fetchImpl } = recorder(call => call.url.includes('/door/anthropic/')
      ? stalled(anthropicStream(['Read before ', 'the clock ran out.'], null, { withStop: false }))
      : stalled([openRouterChunk({ content: '', reasoning: 'still thinking' })]))
    const started = Date.now()
    const council = await consultProviders({ prompt: 'p', timeoutMs: 1000, targets: [{ provider: 'anthropic', model: 'Fable 5.2' }, { provider: 'openrouter', model: 'Kimi K3.1' }] },
      { origin: ORIGIN, fetchImpl })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(council.ok).toBe(true)
    expect(council.answers?.[0]).toEqual(expect.objectContaining({ ok: true, text: 'Read before the clock ran out.', truncated: true,
      stopReason: 'consult_timeout_cap', code: null,
      next: 'The answer was still streaming when timeoutMs 1000 ran out and was cut here; ask for the rest in a follow-up consult, or ask again with a larger timeoutMs (up to 600000).' }))
    // Only thinking before the clock ran out: there is no answer to keep, so it stays a timeout.
    expect(council.answers?.[1]).toEqual(expect.objectContaining({ ok: false, text: null, truncated: false, code: 'CONSULT_TIMEOUT' }))
    expect(released).toBe(2)

    const caller = new AbortController()
    const { fetchImpl: cancelled } = recorder(() => {
      setTimeout(() => { caller.abort() }, 20)
      return stalled(anthropicStream(['Half an answer'], null, { withStop: false }))
    })
    expect((await consultProviders({ model: 'Fable 5.2', prompt: 'p', timeoutMs: 600_000 }, { origin: ORIGIN, fetchImpl: cancelled, signal: caller.signal })).answers?.[0])
      .toEqual(expect.objectContaining({ ok: false, text: null, truncated: false, code: 'CONSULT_CANCELLED' }))
  })
})
