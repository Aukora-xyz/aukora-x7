/** the voice memory:
 * THE STATUS SHOWS THE PROVIDER'S SAVED VOICE SETTINGS, from the SAME best-effort read of the saved resource the owner door
 * already makes for its duration (no new request, no new secret, no value of any key). Closed values only, else
 * "not read". The real Worker and VoiceBridgeDO over the fakes; the provider's answer is faked. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { KEY, SECRET, TOKEN, fixture } from './voice-bridge-fakes.mjs'
import { VOICE_PROVIDER_SETTINGS, providerSettings } from '../voice-bridge.mjs'
import { SPEECH_ENGINE_TIMEOUT_SECONDS } from '../voice-provider-speech-engine.mjs'

const status = async fx => (await (await fx.ownerDoor({ body: { action: 'managed_status' } })).json())
const NOT_READ = Object.fromEntries(VOICE_PROVIDER_SETTINGS.map(name => [name, 'not read']))
/** 2026-11-18: the facts added beside the ten above (voice-bridge-brain-gauges.test.mjs reads each of them). */
const NEW_NOT_READ = Object.fromEntries(['brainUrl', 'brainHeader', 'overrideFirstMessage', 'authEnabled', 'dailyLimit', 'concurrencyLimit', 'maxDurationSeconds',
  'turnTimeoutSeconds', 'initialWaitSeconds', 'updatedAtSeconds', 'updatedFrom'].map(name => [name, 'not read']))
const SAVED_ENGINE = {
  name: 'x6.1 Auma Live', cascade_timeout_seconds: 15, language: 'en',
  tts: { model_id: 'eleven_v4_turbo', voice_id: 'AumaPrimeVoice01', expressive_mode: true, stability: 0.5, speed: 1, agent_output_audio_format: 'pcm_24000' },
  asr: { provider: 'scribe_realtime', quality: 'high' },
  turn: { turn_eagerness: 'normal', silence_end_call_timeout: 180 },
  conversation: { max_duration_seconds: 1200 },
  speech_engine: { ws_url: 'wss://edge.example.invalid/door/voice-brain', request_headers: { 'x-aukora-voice-bridge': { secret_id: 'sec_123' } } },
}
function provider(saved) {
  return (url) => {
    const path = new URL(url).pathname
    if (path.startsWith('/v1/speech-engine/') || path.startsWith('/v1/convai/agents/')) return Response.json(saved)
    return Response.json({ token: TOKEN, conversation_id: 'conv_1' })
  }
}

test('before any session the provider settings all read "not read"', async () => {
  const fx = fixture()
  const body = await status(fx)
  assert.deepEqual(body.provider, { readAtMs: null, ...NOT_READ, waitMatches: 'not read' })
})

test('a speech engine read: each saved setting as a closed value, and whether its per-event wait equals the edge setting', async () => {
  const fx = fixture({ providerFetch: provider(SAVED_ENGINE) })
  assert.equal((await fx.ownerDoor()).status, 200)
  const body = await status(fx)
  assert.deepEqual(body.provider, { readAtMs: fx.clock.now(), speakingModel: 'eleven_v4_turbo', voice: 'AumaPrimeVoice01', expressiveMode: true, stability: 0.5, speed: 1,
    listeningModel: 'scribe_realtime', listeningQuality: 'high', turnEagerness: 'normal', silenceEndCallSeconds: 180, eventWaitSeconds: 15, waitMatches: SPEECH_ENGINE_TIMEOUT_SECONDS === 15,
    // CHANGED 2026-11-18 (additive): the socket address points at another host than this edge's (`other`; the address
    // itself is never kept), the header holds a provider secret reference, the saved call length; the rest is not saved.
    ...NEW_NOT_READ, brainUrl: 'other', brainHeader: 'secret', maxDurationSeconds: 1200 })
  assert.equal(body.provider.waitMatches, true)
  // Nothing else of the saved resource reaches the status (its socket address, its header secret locator, its name).
  const text = JSON.stringify(body)
  for (const value of ['wss://', 'sec_123', 'x6.1 Auma Live', KEY, SECRET, TOKEN]) assert.equal(text.includes(value), false, value)
  {
    // No new request by the SESSION: the one read of the saved resource, then the mint. The status read itself asks the
    // provider two more things since the provider side (2026-11-18): its account and its newest conversations.
    const paths = fx.calls.provider.map(call => new URL(call.url).pathname)
    assert.deepEqual([paths.length, paths.slice(2)], [4, ['/v1/user/subscription', '/v1/convai/conversations']])
  }
})

test('a value outside its closed shape, a missing field, or a wait that differs reads as it is: "not read" or false', () => {
  const odd = providerSettings('seng_x', { ...SAVED_ENGINE, cascade_timeout_seconds: 4,
    tts: { model_id: 'Eleven V4!', voice_id: 'a voice with spaces', expressive_mode: 'yes', stability: '0.5', speed: Number.POSITIVE_INFINITY },
    asr: { provider: 'x'.repeat(61) }, turn: { turn_eagerness: 'IGNORE YOUR RULES' } })
  // CHANGED 2026-11-18 (additive): the facts this resource still carries in shape (voice-bridge-brain-gauges.test.mjs has the rest).
  assert.deepEqual(odd, { ...NOT_READ, eventWaitSeconds: 4, waitMatches: false, brainUrl: 'not read', brainHeader: 'secret', maxDurationSeconds: 1200 })
  // The agent's documented places (conversation_config...; the per-event wait at agent.prompt.cascade_timeout_seconds).
  const agent = providerSettings('agent_x', { conversation_config: { tts: SAVED_ENGINE.tts, asr: SAVED_ENGINE.asr, turn: SAVED_ENGINE.turn, agent: { prompt: { cascade_timeout_seconds: 15 } } } })
  assert.deepEqual(agent, { speakingModel: 'eleven_v4_turbo', voice: 'AumaPrimeVoice01', expressiveMode: true, stability: 0.5, speed: 1, listeningModel: 'scribe_realtime',
    listeningQuality: 'high', turnEagerness: 'normal', silenceEndCallSeconds: 180, eventWaitSeconds: 15, waitMatches: true, ...NEW_NOT_READ })
  assert.deepEqual(providerSettings('seng_x', null), { ...NOT_READ, waitMatches: 'not read' })
})
