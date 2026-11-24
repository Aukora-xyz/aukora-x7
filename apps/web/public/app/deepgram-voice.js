// AUKORA — AUMA · LIVE: HER VOICE ORGAN OVER DEEPGRAM, SO VOICE WORKS ON ANY COMPUTER.
//
// WHY THIS FILE EXISTS. Auma Live speaks one small protocol to a "voice sidecar" (`VoiceLink` in aumalive.js): a
// WebSocket at /stock-apps/auma-live/voice that takes 16 kHz microphone frames and answers with what was said, and
// takes sentences and answers with her voice as PCM. That sidecar was a program on one Mac. No host in this repository
// serves that socket, so away from that Mac Auma Live could only fall back to the browser's own voice.
//
// THIS IS THE SAME PROTOCOL, ANSWERED IN THE PAGE. `voiceSocketFor(url)` returns an object that looks like that
// WebSocket to VoiceLink and is, behind it, two Deepgram streams: one that listens (speech to text) and one that speaks
// (text to speech). Auma Live itself is unchanged apart from the one line that opens the socket and the words that
// said "local". Nothing here decides anything about her: it moves audio one way and text the other.
//
// THE KEY NEVER COMES HERE. The page asks its own host for a short-lived pass (`POST /_host/voice`,
// `{ action: 'speech_pass' }`), which the host mints from a secret only it holds; Deepgram accepts the pass for about
// thirty seconds, long enough to open a stream, and a stream that is open stays open. A host that has no such secret,
// or no such route, answers otherwise, and then this file opens the real sidecar socket exactly as before: where a
// local sidecar exists it still works, and where none does Auma Live falls back (see WHO LISTENS below).
//
// A DEFINITE NO IS REMEMBERED FOR A MINUTE, AND ONLY A DEFINITE NO. VoiceLink asks again every 4 s, so a host that has
// no pass to give is not asked each time. Definite: the host answered and it was not a pass (no such route, a refusal,
// a body that is not a pass), and the one 5xx that says so in words: `503 { code: 'SPEECH_PROVIDER_UNCONFIGURED' }`,
// which is the edge saying it holds no Deepgram key (deploy/cloudflare/src/voice-director.mjs). Every other 5xx, a 429
// and a 408 are a host that is busy or broken just now: nothing is learned, and the next attempt asks again. Start
// Voice forgets the memory (`forgetNoPass`), since the key may have been set in the meantime.
//
// WHO LISTENS WHEN THERE IS NO ORGAN (`voiceInputPlan`, the last export). With neither Deepgram nor a sidecar, the only
// recogniser left is the browser's own, and that one is the browser vendor's service. The rule: pressing Start
// Voice, once the host has authorized it, is consent to that fallback for this page session, never before the press and
// never kept; and it is a fallback, so it waits until the organ has answered that it is not here. Auma Live cannot be
// loaded in a test, so the decision and the words it puts on screen live here, as one pure function the page asks.
//
// WHAT LEAVES THE DEVICE, said plainly because the app's older words called this organ "local": with Deepgram the
// microphone audio VoiceLink forwards, and every sentence she speaks, go to Deepgram. `ready` carries
// `cloud: 'Deepgram'` so the app can say so.
//
// THE PROTOCOL (aumalive.js VoiceLink and its handlers), and how each part is answered:
//   server -> app  {t:'ready', voices:[{id,label,hint,engine}], default_voice}   once the listening stream is open
//   app -> server  binary Int16 mono 16 kHz, 640 samples (40 ms) a frame          forwarded to Deepgram as they are
//   server -> app  {t:'vad', speaking:true}                                       Deepgram's SpeechStarted
//   server -> app  {t:'final', text}                                              the finished utterance (see FINALS)
//   app -> server  {t:'tts', id, text, voice, speed, first}                       spoken in order, one at a time
//   server -> app  {t:'tts_begin', id, sr:24000}, binary Int16 mono, {t:'tts_end', id}
//   app -> server  {t:'tts_cancel'}  ->  server -> app {t:'tts_cancelled'}        Deepgram's Clear; what follows is dropped
//   app -> server  {t:'reset'}                                                    forgets a half-heard utterance (Deepgram is told to
//                                                                                 finalize it, and that result is thrown away)
//   app -> server  {t:'her', on}                                                  nothing to do: the app's own gate decides
//   server -> app  {t:'err', where:'tts', id} then {t:'tts_end', id}              a sentence that could not be spoken (the app
//                                                                                 speaks it itself, and stops counting it)
//   close code 4001                                                               a newer Auma window took the voice
//
// FINALS. Deepgram sends interim results, then results marked `is_final` for each stretch it is sure of, and marks
// the end of what was said with `speech_final` or an `UtteranceEnd`. The app has no use for interim text, so the sure
// stretches are joined and sent as ONE `final` at that end.
//
// HER DEFAULT VOICE IS SIENNA, the voice of the AUKORA.xyz landing page: Deepgram's Flux
// text-to-speech model `flux-sienna-en`, spoken on `/v2/speak`, not `/v1/speak`. Each voice's stream is read in its own
// dialect (https://developers.deepgram.com/docs/flux-tts/server-messages, client-messages, migrating):
//   Flux   (/v2/speak, flux-*)   {type:'Connected', model_name} when the stream is ready (nothing is sent before it);
//                                 per sentence {type:'SpeechStarted', speech_id}, {type:'Flushed'} (BEFORE its audio, so
//                                 it ends nothing), audio, then {type:'SpeechMetadata', speech_id}, which ends it. A cut
//                                 is {type:'Interrupt'}, answered by {type:'SpeechInterrupted'}, or ignored with a Warning
//                                 when it came before any audio (the cut turn then finishes as usual); Flux has no Clear
//                                 (a Clear is a parse Error that closes the stream). Audio carries no id, so a Flux frame
//                                 is played only while the turn Flux last announced is the sentence being spoken: a cut
//                                 turn's audio can never play as the next sentence. Idle for 60 s, Flux closes the stream
//                                 (NET-0004), so an idle stream is sent a Flush that speaks nothing every FLUX_KEEPALIVE_MS.
//   Aura-2 (/v1/speak, aura-2-*) audio, then {type:'Flushed'} at the end of a sentence; a Clear is answered by Cleared.
// Thalia, Andromeda, Helena and Apollo stay selectable on Aura-2. Every stream, the listening one too, is opened with
// `mip_opt_out=true`, as AUKORA.xyz opens them.
//
// VERIFIED AGAINST DEEPGRAM (a browser-equivalent socket with a pass in the subprotocol): the listening
// stream's SpeechStarted, Results and UtteranceEnd; the Aura-2 speaking stream's audio frames (even byte lengths, first
// audio after about 0.3 s), Flushed, and Clear answered by Cleared; Finalize answered by a result marked from_finalize.
// Flux (same day, Node's browser-equivalent WebSocket, a /v1/auth/grant pass as ['bearer', pass], mip_opt_out=true):
// the pass is accepted on /v2/speak; Connected names model 'sienna'; three sentences on one stream each gave
// SpeechStarted, Flushed, even-length 24 kHz audio, SpeechMetadata; an Interrupt mid-sentence let a few frames through
// and was answered by SpeechInterrupted; a Clear was refused (Error MESSAGE-0000, close 1003); an idle stream was closed
// at 60 s (NET-0004) while one sent a Flush every 25 s stayed open past 78 s and spoke normally.
// NOT VERIFIED: a run inside Auma Live on a host that mints the pass, because no host does yet.

/** The host's route for a short-lived Deepgram pass, and the action it is asked with. */
export const SPEECH_PASS_ROUTE = '/_host/voice';
export const SPEECH_PASS_ACTION = 'speech_pass';
const LISTEN_URL = 'wss://api.deepgram.com/v1/listen';
/** Aura-2 voices are spoken here; Flux voices (`flux-*`) on FLUX_SPEAK_URL. */
const SPEAK_URL = 'wss://api.deepgram.com/v1/speak';
const FLUX_SPEAK_URL = 'wss://api.deepgram.com/v2/speak';
/** What VoiceLink's player is told the speech is sampled at. */
export const SPEAK_SAMPLE_RATE = 24000;
/** How long a host that has no pass to give is not asked again. VoiceLink reconnects every 4 s; this keeps that quiet. */
export const NO_PASS_MEMORY_MS = 60000;
/** What the edge answers, with a 503, when it holds no Deepgram key: the one 5xx that is a definite "no pass here". */
export const SPEECH_UNCONFIGURED_CODE = 'SPEECH_PROVIDER_UNCONFIGURED';
/** A sentence that produces no audio and no end within this long is reported as failed, so the app speaks it itself. */
export const SPEAK_TIMEOUT_MS = 15000;
/** Deepgram closes a listening stream that hears nothing for about ten seconds; the app's gate may drop every frame while she speaks. */
export const KEEPALIVE_MS = 4000;
/** The host is given this long to answer a pass request; VoiceLink leaves a socket alone while it is still connecting. */
export const PASS_TIMEOUT_MS = 5000;
/** After a reset, what Deepgram had half-heard is thrown away; this long at most, so it can never stick. */
export const DISCARD_MS = 1500;
/** An idle Flux stream is sent a Flush that speaks nothing this often, so Flux's 60 s inactivity close never comes. */
export const FLUX_KEEPALIVE_MS = 25000;
/** The most text sent to Deepgram as one piece; a longer sentence is sent as several pieces, whole. */
export const SPEAK_PIECE_CHARS = 1800;
/**
 * How long Deepgram waits in silence before it decides he has finished speaking (`endpointing` on the listening
 * stream). It comes BEFORE his `final` reaches the page, so the timing line cannot measure it and shows it as this
 * constant. Named here so the listening URL and the line can never disagree; its value is unchanged (B4 is later).
 */
export const END_OF_SPEECH_MS = 800;
const OWNER_CHANNEL = 'auma-live-voice-owner';

/**
 * Her voices on Deepgram, in the shape VoiceLink's picker reads. `engine` is not one of the sidecar's two ('pocket',
 * 'kokoro'), so the picker tags them "fast", which they are.
 */
export const DEEPGRAM_VOICES = Object.freeze([
  Object.freeze({ id: 'flux-sienna-en', label: 'Sienna', hint: 'natural and expressive · Deepgram', engine: 'deepgram' }),
  Object.freeze({ id: 'aura-2-thalia-en', label: 'Thalia', hint: 'clear and warm · Deepgram', engine: 'deepgram' }),
  Object.freeze({ id: 'aura-2-andromeda-en', label: 'Andromeda', hint: 'easy and expressive · Deepgram', engine: 'deepgram' }),
  Object.freeze({ id: 'aura-2-helena-en', label: 'Helena', hint: 'gentle and steady · Deepgram', engine: 'deepgram' }),
  Object.freeze({ id: 'aura-2-apollo-en', label: 'Apollo', hint: 'calm and confident · Deepgram', engine: 'deepgram' }),
]);
const VOICE_IDS = new Set(DEEPGRAM_VOICES.map(voice => voice.id));
/** Sienna (`flux-sienna-en`), as on the AUKORA.xyz landing page. */
export const DEEPGRAM_DEFAULT_VOICE = DEEPGRAM_VOICES[0].id;

/** Whether a voice is a Flux voice, spoken on `/v2/speak` with Flux's frames. */
export const isFluxVoice = voice => voice.startsWith('flux-');
/**
 * The speaking stream's URL for one of her voices (only ids from DEEPGRAM_VOICES ever reach here).
 * @param {string} voice - the voice id.
 * @returns {string} the URL.
 */
export function speakUrlFor(voice) {
  return `${isFluxVoice(voice) ? FLUX_SPEAK_URL : SPEAK_URL}?model=${voice}&encoding=linear16&sample_rate=${SPEAK_SAMPLE_RATE}&mip_opt_out=true`;
}
/** The names Flux's `Connected` may give a voice: its id, or its short name (`flux-sienna-en` -> `sienna`). */
const fluxNames = voice => [voice, voice.replace(/^flux-/, '').replace(/-[a-z]{2}$/, '')];

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

let noPassUntil = 0;

/**
 * Ask this page's host for a short-lived Deepgram pass.
 * @param {typeof fetch} fetchImpl - the page's fetch.
 * @param {() => number} now - the clock.
 * @returns {Promise<string|null>} the pass, or null when this host gives none (a definite no is remembered for a minute).
 */
export async function speechPass(fetchImpl = globalThis.fetch.bind(globalThis), now = Date.now) {
  if (now() < noPassUntil) return null;
  // Only a DEFINITE no is remembered (the host answered, and not with a pass). A request that failed on the way, timed
  // out, or met a busy host says nothing about the host: the next attempt asks again. ONE 5xx IS DEFINITE: a 503 whose
  // body names SPEECH_PROVIDER_UNCONFIGURED is the host saying it has no key, which a retry in 4 s will not change.
  let definite = false;
  try {
    const response = await fetchImpl(SPEECH_PASS_ROUTE, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: SPEECH_PASS_ACTION }),
      ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(PASS_TIMEOUT_MS) } : {}),
    });
    definite = response.status < 500 && response.status !== 429 && response.status !== 408;
    // The body is read once, and only where it can say something: a pass, or the 503's code. One that is not JSON (a
    // gateway's own 503 page) reads as nothing, and that 503 stays "nothing learned".
    const body = response.ok || response.status === 503 ? await response.json().catch(() => null) : null;
    if (response.status === 503 && isRecord(body) && body.code === SPEECH_UNCONFIGURED_CODE) definite = true;
    // Characters a WebSocket subprotocol may carry: a pass that could not be offered to Deepgram is no pass.
    if (response.ok && isRecord(body) && body.ok === true && body.provider === 'deepgram' && typeof body.accessToken === 'string'
      && /^[A-Za-z0-9._~-]{20,4096}$/.test(body.accessToken)) return body.accessToken;
  } catch { /* nothing is learned about the host from a request that did not complete */ }
  if (definite) noPassUntil = now() + NO_PASS_MEMORY_MS;
  return null;
}

/** Forget that the host gave no pass (a test, or the owner turning voice on again after the host was set up). */
export function forgetNoPass() { noPassUntil = 0; }

/**
 * The socket VoiceLink opens. It has the members VoiceLink uses of a WebSocket: `binaryType`, `readyState`, `onmessage`,
 * `onclose`, `onerror`, `send`, `close`.
 * @param {string} url - the sidecar URL VoiceLink built (`…/stock-apps/auma-live/voice?owner=…`).
 * @param {object} [deps] - for tests: `WebSocketImpl`, `fetchImpl`, `now`, `setTimer`, `clearTimer`, `BroadcastChannelImpl`.
 * @returns {object} the socket.
 */
export function voiceSocketFor(url, deps = {}) {
  const WebSocketImpl = deps.WebSocketImpl ?? globalThis.WebSocket;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle));
  const ChannelImpl = 'BroadcastChannelImpl' in deps ? deps.BroadcastChannelImpl : globalThis.BroadcastChannel;

  const socket = { binaryType: 'arraybuffer', readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, cloud: null };
  let closed = false;
  let native = null;       // the real sidecar socket, when the host gives no pass
  let listen = null;       // Deepgram, listening
  let speak = null;        // Deepgram, speaking, for `speakVoice`
  let speakVoice = '';
  let speakOpening = null;
  let speakOpeningVoice = '';
  let discarding = null;   // a timer while what Deepgram had half-heard before a reset is being thrown away
  let keepAlive = null;
  let ownerChannel = null;
  let heard = [];          // the stretches Deepgram is sure of, until the utterance ends
  const queue = [];        // sentences waiting to be spoken
  let current = null;      // { id, begun, timer } the sentence being spoken
  let dropAudio = false;   // Aura-2: true from a cancel until Deepgram says Cleared; what arrives meanwhile is not hers to play
  let speakBeat = null;    // the Flux keep-alive timer
  // FLUX TURNS, per stream: every id Flux announced, the ids of turns that were cut, how many cut turns Flux has not
  // announced yet (the next announcements are theirs, since Flux keeps turns in order), and the turn now announced.
  let fluxIds = new Set();
  let cutIds = new Set();
  let unannouncedCuts = 0;
  let activeId = null;
  const resetFlux = () => { fluxIds = new Set(); cutIds = new Set(); unannouncedCuts = 0; activeId = null; };
  let odd = null;          // a byte held back so every frame passed on is whole 16-bit samples
  let owner = '';
  try { owner = new URL(url, 'http://localhost').searchParams.get('owner') ?? ''; } catch { owner = ''; }

  const deliver = (data) => { if (!closed) { try { socket.onmessage?.({ data }); } catch { /* the app's handler is its own */ } } };
  const say = message => deliver(JSON.stringify(message));
  const finish = (code) => {
    if (closed) return;
    closed = true;
    socket.readyState = 3;
    if (keepAlive !== null) { clearTimer(keepAlive); keepAlive = null; }
    if (current?.timer != null) clearTimer(current.timer);
    if (discarding !== null) { clearTimer(discarding); discarding = null; }
    if (speakBeat !== null) { clearTimer(speakBeat); speakBeat = null; }
    for (const upstream of [listen, speak]) {
      if (upstream) { upstream.onopen = upstream.onmessage = upstream.onerror = upstream.onclose = null; try { upstream.close(); } catch { /* closed */ } }
    }
    listen = null; speak = null;
    if (ownerChannel) { ownerChannel.onmessage = null; try { ownerChannel.close(); } catch { /* closed */ } ownerChannel = null; }
    try { socket.onclose?.({ code, reason: '' }); } catch { /* the app's handler is its own */ }
  };

  // ---- the real sidecar, exactly as before, when this host gives no pass ----
  const openNative = () => {
    let real;
    try { real = new WebSocketImpl(url); } catch { finish(1006); return; }
    native = real;
    real.binaryType = 'arraybuffer';
    real.onopen = () => { if (!closed) socket.readyState = 1; };
    real.onmessage = event => deliver(event.data);
    real.onerror = () => { try { socket.onerror?.(); } catch { /* */ } };
    real.onclose = (event) => { native = null; finish(event?.code ?? 1006); };
  };

  // ---- listening ----
  const endUtterance = () => {
    const text = heard.join(' ').replace(/\s+/g, ' ').trim();
    heard = [];
    if (text) say({ t: 'final', text });
  };
  const onListen = (event) => {
    if (typeof event.data !== 'string') return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (!isRecord(message)) return;
    if (message.type === 'SpeechStarted') { say({ t: 'vad', speaking: true }); return; }
    // AFTER A RESET (the app sends one on mute, "so a half-heard phrase never fires"): Deepgram was told to finalize what
    // it held, and everything up to that finalized result is thrown away, not heard.
    if (discarding !== null) {
      heard = [];
      if (message.type === 'Results' && message.from_finalize === true) { clearTimer(discarding); discarding = null; }
      return;
    }
    if (message.type === 'UtteranceEnd') { endUtterance(); return; }
    if (message.type !== 'Results') return;
    const alternative = isRecord(message.channel) && Array.isArray(message.channel.alternatives) ? message.channel.alternatives[0] : null;
    const text = isRecord(alternative) && typeof alternative.transcript === 'string' ? alternative.transcript.trim() : '';
    if (message.is_final === true && text) heard.push(text);
    if (message.speech_final === true) endUtterance();
  };

  // ---- speaking ----
  // A SENTENCE THAT COULD NOT BE SPOKEN IS STILL ANSWERED TO ITS END. The app counts each sentence as pending until its
  // `tts_end`; an `err` alone makes it speak the sentence itself (when none of it had played) but leaves it pending, and
  // a sentence left pending keeps her "audible" to the app's gate, which then drops the microphone. So: err, then end.
  const fail = (id) => { say({ t: 'err', where: 'tts', id }); say({ t: 'tts_end', id }); };
  const failCurrent = () => {
    const failed = current;
    current = null;
    if (failed?.timer != null) clearTimer(failed.timer);
    if (failed) fail(failed.id);
  };
  const armTimeout = (sentence) => {
    if (sentence.timer != null) clearTimer(sentence.timer);
    sentence.timer = setTimer(() => { if (current === sentence) { failCurrent(); closeSpeak(); next(); } }, SPEAK_TIMEOUT_MS);
  };
  const closeSpeak = () => {
    const old = speak;
    speak = null; speakVoice = ''; odd = null;
    if (speakBeat !== null) { clearTimer(speakBeat); speakBeat = null; }
    resetFlux();
    if (old) { old.onopen = old.onmessage = old.onerror = old.onclose = null; try { old.close(); } catch { /* closed */ } }
  };
  // The sentence being spoken has reached its end (Aura-2's Flushed, Flux's SpeechMetadata).
  const endCurrent = () => {
    const done = current;
    current = null;
    if (done.timer != null) clearTimer(done.timer);
    odd = null;
    // A sentence that came back with no audio at all was not spoken: the app is told, and speaks it itself.
    if (done.begun) say({ t: 'tts_end', id: done.id }); else fail(done.id);
    next();
  };
  const onAudio = (data) => {
    if (dropAudio || !current) return;
    let bytes = new Uint8Array(data);
    if (odd !== null) { const joined = new Uint8Array(bytes.length + 1); joined[0] = odd; joined.set(bytes, 1); bytes = joined; odd = null; }
    if (bytes.length % 2 === 1) { odd = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1); }
    if (bytes.length === 0) return;
    if (!current.begun) { current.begun = true; say({ t: 'tts_begin', id: current.id, sr: SPEAK_SAMPLE_RATE }); }
    // The timeout is for a stream gone quiet, not for a long sentence: every frame of audio restarts it.
    armTimeout(current);
    deliver(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const controlOf = (event) => {
    let message; try { message = JSON.parse(event.data); } catch { return null; }
    return isRecord(message) ? message : null;
  };
  // AURA-2 (/v1/speak): audio, then Flushed at the end of each sentence; a Clear is answered by Cleared.
  const onSpeak = (event) => {
    if (typeof event.data !== 'string') { onAudio(event.data); return; }
    const message = controlOf(event);
    if (message === null) return;
    if (message.type === 'Cleared') { dropAudio = false; odd = null; return; }
    if (message.type === 'Flushed' && current && !dropAudio) endCurrent();
  };
  // FLUX (/v2/speak): each sentence is announced (SpeechStarted, with its id), spoken, and closed (SpeechMetadata, the same
  // id). Flux's Flushed comes BEFORE the sentence's audio, so it ends nothing: only SpeechMetadata does, and only its own,
  // so one sentence can never end the next. AUDIO IS PLAYED ONLY UNDER ITS OWN TURN: a frame goes to the app only while
  // the turn Flux last announced is the one bound to the sentence being spoken. A cut turn (and anything Flux still sends
  // about it, whether it was interrupted or the Interrupt was ignored because no audio existed yet) is never bound to a
  // sentence, so its words cannot play as the next one. Warning, Flushed and SessionMetadata say nothing the app needs.
  const onFluxSpeak = (event) => {
    if (typeof event.data !== 'string') {
      if (current && activeId !== null && current.speechId === activeId) onAudio(event.data);
      return;
    }
    const message = controlOf(event);
    if (message === null) return;
    const idOf = value => (typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null);
    const speechId = idOf(message.speech_id);
    if (message.type === 'SpeechStarted') {
      if (speechId === null || fluxIds.has(speechId)) return;
      fluxIds.add(speechId);
      activeId = speechId;
      // Flux announces turns in the order they were sent: a cut turn not announced yet comes before any later sentence.
      if (unannouncedCuts > 0) { unannouncedCuts -= 1; cutIds.add(speechId); return; }
      if (current && current.sent && current.speechId == null) current.speechId = speechId;
      return;
    }
    if (message.type === 'SpeechInterrupted') {
      const cutId = idOf(isRecord(message.metadata) ? message.metadata.speech_id : null);
      if (cutId !== null && cutId === activeId) activeId = null;
      // A cut turn Flux had not announced is accounted for by its interruption.
      if (cutId !== null && !fluxIds.has(cutId) && unannouncedCuts > 0) { unannouncedCuts -= 1; fluxIds.add(cutId); cutIds.add(cutId); }
      return;
    }
    if (message.type === 'SpeechMetadata') {
      if (speechId !== null && speechId === activeId) activeId = null;
      if (speechId !== null && cutIds.has(speechId)) return;
      const unknown = speechId === null || !fluxIds.has(speechId);
      // The end of a cut turn Flux never announced (an empty one) is that turn's, not the next sentence's.
      if (unknown && unannouncedCuts > 0) { unannouncedCuts -= 1; if (speechId !== null) cutIds.add(speechId); return; }
      if (!current) return;
      // Its own end, or (when Flux announced none for it) an end no earlier sentence owns.
      const own = current.speechId != null ? speechId === current.speechId : unknown;
      if (own) endCurrent();
      return;
    }
    // Flux could not speak it: the sentence fails (the app speaks it), and the next one gets a fresh stream.
    if (message.type === 'Error') { const upstream = speak; failCurrent(); if (speak === upstream) closeSpeak(); next(); }
  };
  const speakSocket = async (voice) => {
    if (speak && speakVoice === voice && speak.readyState === 1) return speak;
    // A stream still being opened is used only for the voice it is being opened in; one opening for another voice is
    // waited for and then replaced, so a sentence is never spoken in the wrong voice.
    if (speakOpening) {
      if (speakOpeningVoice === voice) return speakOpening;
      await speakOpening.catch(() => null);
      return speakSocket(voice);
    }
    closeSpeak();
    speakOpeningVoice = voice;
    speakOpening = (async () => {
      const pass = await speechPass(fetchImpl, now);
      if (pass === null || closed) return null;
      const flux = isFluxVoice(voice);
      return await new Promise((resolve) => {
        let upstream;
        let settled = false;
        let waiting = null;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          if (waiting !== null) { clearTimer(waiting); waiting = null; }
          resolve(value);
        };
        try { upstream = new WebSocketImpl(speakUrlFor(voice), ['bearer', pass]); } catch { settle(null); return; }
        upstream.binaryType = 'arraybuffer';
        const take = () => {
          if (closed) { try { upstream.close(); } catch { /* */ } settle(null); return; }
          speak = upstream; speakVoice = voice; dropAudio = false; odd = null; resetFlux();
          upstream.onmessage = flux ? onFluxSpeak : onSpeak;
          upstream.onclose = () => { if (speak === upstream) { closeSpeak(); failCurrent(); next(); } };
          // FLUX CLOSES A STREAM IDLE FOR 60 S: while no sentence is in flight it is sent a Flush that speaks nothing
          // (Flux answers NO_ACTIVE_SPEECH), so her next sentence does not wait for a new pass and a new stream.
          if (flux) {
            const beat = () => {
              speakBeat = setTimer(() => {
                speakBeat = null;
                if (speak !== upstream || closed) return;
                // Not while a cut turn is still being said or announced (a Flush would end that turn, not nothing).
                const idle = current === null && activeId === null && unannouncedCuts === 0;
                if (idle) { try { upstream.send(JSON.stringify({ type: 'Flush' })); } catch { /* the close says it */ } }
                beat();
              }, FLUX_KEEPALIVE_MS);
            };
            beat();
          }
          settle(upstream);
        };
        if (flux) {
          // NOTHING IS SENT BEFORE FLUX SAYS IT IS CONNECTED, in the voice asked for (AUKORA.xyz waits the same way). A
          // stream that never says so is given up, so a sentence is never left waiting on it.
          upstream.onopen = () => {
            if (closed) { try { upstream.close(); } catch { /* */ } settle(null); return; }
            waiting = setTimer(() => { waiting = null; try { upstream.close(); } catch { /* */ } settle(null); }, SPEAK_TIMEOUT_MS);
          };
          upstream.onmessage = (event) => {
            if (typeof event.data !== 'string') return;
            const message = controlOf(event);
            if (message?.type !== 'Connected') return;
            if (!fluxNames(voice).includes(message.model_name)) { try { upstream.close(); } catch { /* */ } settle(null); return; }
            take();
          };
        } else upstream.onopen = take;
        upstream.onerror = () => { /* the close says it */ };
        upstream.onclose = () => settle(null);
      });
    })();
    const opening = speakOpening;
    try { return await opening; } finally { if (speakOpening === opening) { speakOpening = null; speakOpeningVoice = ''; } }
  };
  const next = () => {
    if (closed || current || queue.length === 0) return;
    const request = queue.shift();
    // `sent`: its Speak and Flush went out on the stream (only then can a turn Flux announces be its).
    current = { id: request.id, begun: false, timer: null, speechId: null, sent: false };
    const mine = current;
    armTimeout(mine);
    void speakSocket(request.voice).then((upstream) => {
      if (current !== mine) return;
      if (!upstream) { failCurrent(); next(); return; }
      try {
        // The whole sentence, in pieces Deepgram takes, cut at spaces; one Flush ends it.
        let rest = request.text;
        while (rest.length > 0) {
          let cut = rest.length <= SPEAK_PIECE_CHARS ? rest.length : rest.lastIndexOf(' ', SPEAK_PIECE_CHARS);
          if (cut <= 0) cut = Math.min(rest.length, SPEAK_PIECE_CHARS);
          upstream.send(JSON.stringify({ type: 'Speak', text: rest.slice(0, cut) }));
          rest = rest.slice(cut);
        }
        upstream.send(JSON.stringify({ type: 'Flush' }));
        mine.sent = true;
      } catch { failCurrent(); next(); }
    });
  };
  const cancelSpeech = () => {
    queue.length = 0;
    const cut = current;
    current = null;
    if (cut?.timer != null) clearTimer(cut.timer);
    odd = null;
    if (speak && speak.readyState === 1 && cut) {
      if (isFluxVoice(speakVoice)) {
        // FLUX has no Clear (it would close the stream): a cut sentence whose words went out is told Interrupt. Its turn is
        // marked cut, by id when Flux announced it, or as the next announcement when not; either way none of it plays.
        if (cut.sent) {
          if (cut.speechId != null) cutIds.add(cut.speechId); else unannouncedCuts += 1;
          try { speak.send(JSON.stringify({ type: 'Interrupt' })); } catch { closeSpeak(); }
        }
      } else {
        // AURA-2: what Deepgram had already sent or was sending for the cut sentence is not played: dropped until it
        // answers the Clear with Cleared.
        dropAudio = true;
        try { speak.send(JSON.stringify({ type: 'Clear' })); } catch { closeSpeak(); dropAudio = false; }
      }
    }
    say({ t: 'tts_cancelled' });
  };

  // ---- one window owns the voice: a newer owner makes the older one let go, as the sidecar did with code 4001 ----
  const claimOwner = () => {
    if (!ChannelImpl || !owner) return;
    try {
      ownerChannel = new ChannelImpl(OWNER_CHANNEL);
      ownerChannel.onmessage = (event) => {
        const other = isRecord(event.data) && typeof event.data.owner === 'string' ? event.data.owner : '';
        if (other && other !== owner && other > owner) finish(4001);
        // An older claim that arrives after this one announced itself is told, so it lets go.
        else if (other && other < owner) { try { ownerChannel?.postMessage({ owner }); } catch { /* closed */ } }
      };
      ownerChannel.postMessage({ owner });
    } catch { ownerChannel = null; }
  };

  const openDeepgram = (pass) => {
    let upstream;
    try {
      upstream = new WebSocketImpl(`${LISTEN_URL}?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true`
        + `&endpointing=${END_OF_SPEECH_MS}&utterance_end_ms=1000&vad_events=true&smart_format=true`
        + '&keyterm=Auma&keyterm=Aukora&keyterm=Pentora&keyterm=AUMLOK&keyterm=Sienna&mip_opt_out=true', ['bearer', pass]);
    } catch { finish(1006); return; }
    listen = upstream;
    upstream.binaryType = 'arraybuffer';
    upstream.onopen = () => {
      if (closed) return;
      socket.readyState = 1;
      socket.cloud = 'Deepgram';
      keepAlive = setTimer(function beat() {
        if (closed || listen !== upstream) return;
        try { upstream.send(JSON.stringify({ type: 'KeepAlive' })); } catch { /* the close says it */ }
        keepAlive = setTimer(beat, KEEPALIVE_MS);
      }, KEEPALIVE_MS);
      claimOwner();
      say({ t: 'ready', voices: DEEPGRAM_VOICES, default_voice: DEEPGRAM_DEFAULT_VOICE, cloud: 'Deepgram' });
      // The speaking stream is opened now, not at her first sentence, so that sentence does not wait for a pass and a socket.
      void speakSocket(DEEPGRAM_DEFAULT_VOICE);
    };
    upstream.onmessage = onListen;
    upstream.onerror = () => { /* the close says it */ };
    // Deepgram went away: the app is told its organ is down (it falls back, and VoiceLink asks again in 4 s).
    upstream.onclose = () => { if (listen === upstream) { listen = null; finish(1011); } };
  };

  socket.send = (data) => {
    if (closed) return;
    if (native) { try { native.send(data); } catch { /* the close says it */ } return; }
    if (typeof data !== 'string') {
      if (listen && listen.readyState === 1) { try { listen.send(data); } catch { /* the close says it */ } }
      return;
    }
    let message; try { message = JSON.parse(data); } catch { return; }
    if (!isRecord(message)) return;
    if (message.t === 'tts') {
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      if (!Number.isFinite(message.id)) return;
      if (!text) { fail(message.id); return; }
      queue.push({ id: message.id, text, voice: VOICE_IDS.has(message.voice) ? message.voice : DEEPGRAM_DEFAULT_VOICE });
      next();
    } else if (message.t === 'tts_cancel') cancelSpeech();
    else if (message.t === 'reset') {
      heard = [];
      if (listen && listen.readyState === 1) {
        if (discarding !== null) clearTimer(discarding);
        discarding = setTimer(() => { discarding = null; }, DISCARD_MS);
        try { listen.send(JSON.stringify({ type: 'Finalize' })); } catch { /* the close says it */ }
      }
    }
    // {t:'her'}: the app's own gate decides what the microphone forwards while she is audible; nothing to do here.
  };
  socket.close = () => {
    if (closed) return;
    if (native) { const real = native; native = null; real.onclose = real.onmessage = real.onerror = null; try { real.close(); } catch { /* closed */ } }
    if (listen && listen.readyState === 1) { try { listen.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* */ } }
    if (speak && speak.readyState === 1) { try { speak.send(JSON.stringify({ type: 'Close' })); } catch { /* */ } }
    finish(1000);
  };

  void speechPass(fetchImpl, now).then((pass) => {
    if (closed) return;
    if (pass === null) openNative(); else openDeepgram(pass);
  });
  return socket;
}

// ---- who listens when her organ is not here: the decision Auma Live asks, and the only words it shows for it ----

/** Shown for as long as the browser's own recogniser is the one listening. */
export const BROWSER_RECOGNISER_STATUS = 'The browser\'s own recogniser is listening. It is the browser vendor\'s service.';
/** Shown when her organ is not here and nothing else may or can listen. */
export const VOICE_INPUT_UNAVAILABLE_STATUS = 'Voice input is unavailable here. Typing works.';
/**
 * How long a Start Voice waits for the organ to answer (the pass, then the sidecar socket) before it is taken as not
 * here. Normally the organ says so itself, well inside this.
 */
export const ORGAN_WAIT_MS = PASS_TIMEOUT_MS + 3000;

const inputPlan = (path, status, openDrawer) => Object.freeze({ path, status, openDrawer });

/**
 * Who hears the owner right now, and what the screen says about it. Pure: Auma Live gives the facts and does what comes
 * back. THE BROWSER RECOGNISER IS A FALLBACK, NEVER A DEFAULT: it is the path only while the organ is not ready, only
 * when this browser has one and has not refused it, and only by a choice. The choice is Start Voice, authorized by the
 * host, in this page session (`consented`), and then only once the organ has answered that it is not here; or the
 * older switch `window.AUMA_LIVE_ALLOW_CLOUD_VOICE === true` (`flagAllowed`), which as before does not wait for that
 * answer. Only a fact that is exactly `true` counts, so a fact left out is a no.
 * @param {object} [facts] - what the page knows.
 * @param {boolean} [facts.consented] - Start Voice was pressed and the host authorized it, in this page session.
 * @param {boolean} [facts.flagAllowed] - the page was loaded with `window.AUMA_LIVE_ALLOW_CLOUD_VOICE === true`.
 * @param {boolean} [facts.organReady] - her voice organ (Deepgram, or the local sidecar) is connected and hearing.
 * @param {boolean} [facts.organPending] - the organ has been asked for and has not yet answered either way.
 * @param {boolean} [facts.recogniserAvailable] - this browser has a speech recogniser the page may reach.
 * @param {boolean} [facts.recogniserDenied] - the browser refused it, or it failed, since the channel opened.
 * @returns {{path: 'organ'|'browser-recogniser'|'typing', status: string|null, openDrawer: boolean}} `path`: who hears
 * her ('organ' also while the organ is still being waited for: nothing else listens meanwhile). `status`: the line to
 * keep on screen while that is so, or null. `openDrawer`: put the transcript drawer, where typing is, in reach.
 */
export function voiceInputPlan(facts = {}) {
  const fact = name => isRecord(facts) && facts[name] === true;
  if (fact('organReady')) return inputPlan('organ', null, false);
  const usable = (fact('consented') || fact('flagAllowed')) && fact('recogniserAvailable') && !fact('recogniserDenied');
  // The drawer opens for this path too: its line is the one lasting notice that the browser vendor's service is listening.
  if (usable && (fact('flagAllowed') || !fact('organPending'))) return inputPlan('browser-recogniser', BROWSER_RECOGNISER_STATUS, true);
  // Still waiting on the organ: nothing is known to be missing yet, so nothing is said and nothing else listens.
  if (fact('organPending')) return inputPlan('organ', null, false);
  return inputPlan('typing', VOICE_INPUT_UNAVAILABLE_STATUS, true);
}

// ---- the timing line: where the time of one voice turn goes (measurement only) ----
//
// WHY. "Voice works great, still a bit slow." Nothing in the page measured a turn from his last word to her first
// sound, so no change to make her faster could be judged. Auma Live stamps `performance.now()` at each step of a spoken
// turn and hands the stamps here; this keeps the last TIMING_TURNS_KEPT turns IN PAGE MEMORY ONLY and writes ONE plain
// line for the transcript drawer. Nothing is stored, nothing is sent anywhere, no timer is set: it is plain arithmetic
// over numbers the page gives it, so it cannot change what the voice loop asks for or says.
//
// THE STAGES, in the order they happen (each stamp is the page's own clock when the page saw the event):
//   heard       his `final` became a turn (aumalive.js requestTurn). The END_OF_SPEECH_MS wait is before this.
//   sent        the page posted the turn to her session adapter (aumalive.js transmit).
//   journaled, accepted, started
//               `{t:'mark', v:'journaled'|'accepted'|'started'}` frames from the session adapter (genesis-live.js,
//               the page-mind lane). Until it sends them, the hand-off and thinking stages are shown as "?".
//   firstToken  the first text frame of her reply, field tags included.
//   firstText   her first word (her field tags stripped).
//   firstPhrase the first phrase handed to the voice.
//   firstAudio  the first audio of that phrase arriving at the page (needs firstPhrase).
//   firstSound  the player reporting her audible (needs firstAudio): her first sound.
// A mark frame may also carry `model`, `effort`, `toolRounds` (model rounds with tools before her first word) and
// `promptBytes`; they are kept with the turn, bounded, and not shown.
//
// THE CUT-OFF SIGN (the sceptic's): he spoke again (a second final, or Deepgram's SpeechStarted) after a final and
// before her first sound while her reply was still on its way, or within SPOKE_AGAIN_AFTER_MS after her first sound.

/** How many turns the line remembers. */
export const TIMING_TURNS_KEPT = 20;
/** He spoke again this soon after her first sound: counted as a likely cut-off. */
export const SPOKE_AGAIN_AFTER_MS = 2000;
const TIMING_STAMPS = Object.freeze(['sent', 'journaled', 'accepted', 'started', 'firstToken', 'firstText', 'firstPhrase', 'firstAudio', 'firstSound']);
const MARK_STAMPS = Object.freeze(['journaled', 'accepted', 'started']);
const isTime = value => typeof value === 'number' && Number.isFinite(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const seconds = ms => (ms / 1000).toFixed(1);
const span = (from, to) => (isTime(from) && isTime(to) && to >= from ? seconds(to - from) : '?');
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
/** From his `final` to her first sound, when both were measured. */
const turnTotal = turn => (isTime(turn.firstSound) && turn.firstSound >= turn.heard ? turn.firstSound - turn.heard : null);

/**
 * The drawer's line for these turns, or '' while no turn has reached her first sound. Pure.
 * @param {ReadonlyArray<object>} turns - oldest first, as `createTurnTimes().turns()` gives them.
 * @param {number} [endOfSpeechMs] - the fixed wait before `heard`, shown as a constant.
 * @returns {string}
 */
export function timingLine(turns, endOfSpeechMs = END_OF_SPEECH_MS) {
  const list = Array.isArray(turns) ? turns.filter(isRecord) : [];
  const measured = list.filter(turn => turnTotal(turn) !== null);
  // The last reply that ended: measured to her first sound, or closed (cut, aborted, browser voice) before it.
  const last = list.filter(turn => turnTotal(turn) !== null || turn.cut === true).at(-1);
  if (!last) return '';
  const usual = measured.length > 0 ? `usual ${seconds(median(measured.map(turnTotal)))} s over ${measured.length}` : '';
  let line = turnTotal(last) === null
    ? `last reply: cut before first sound${usual ? `; ${usual}` : ''}`
    : `last reply ${seconds(turnTotal(last))} s to first sound (plus ${seconds(endOfSpeechMs)} s end-of-speech wait): `
      + `hand-off ${span(last.heard, last.started)}, thinking ${span(last.started, last.firstText)}, voice ${span(last.firstText, last.firstSound)}; `
      + usual;
  const again = list.filter(turn => turn.againBefore === true || turn.againAfter === true).length;
  if (again > 0) line += `; you spoke again early in ${again} of ${list.length}`;
  return line;
}

/**
 * The page's recorder for the timing line. Every method takes the page's `performance.now()` and returns nothing the
 * voice loop uses; a call with a bad time or an unknown stage does nothing.
 * @param {object} [options]
 * @param {(line: string) => void} [options.onChange] - called with the new line whenever it changes.
 * @param {number} [options.endOfSpeechMs] - the wait shown as a constant (default END_OF_SPEECH_MS).
 */
export function createTurnTimes(options = {}) {
  const onChange = isRecord(options) && typeof options.onChange === 'function' ? options.onChange : () => {};
  const endOfSpeechMs = isRecord(options) && isTime(options.endOfSpeechMs) ? options.endOfSpeechMs : END_OF_SPEECH_MS;
  const turns = [];
  // THE TURN WHOSE REPLY IS PLAYING: set by `claim`, cleared by `close`. Her audio and her sound are credited to it
  // alone, never to whichever turn is newest: a turn cut before her first sound must not take a later turn's sound.
  let current = null;
  let shown = '';
  const changed = () => {
    const line = timingLine(turns, endOfSpeechMs);
    if (line === shown) return;
    shown = line;
    try { onChange(line); } catch { /* the line is a view; it never stops a turn */ }
  };
  const held = turn => isRecord(turn) && turns.includes(turn);
  const stamp = (turn, stage, at) => {
    if (!held(turn) || !TIMING_STAMPS.includes(stage) || !isTime(at) || turn[stage] !== undefined) return;
    if (stage === 'firstAudio' && turn.firstPhrase === undefined) return;   // audio before her phrase is not hers
    if (stage === 'firstSound' && turn.firstAudio === undefined) return;    // a sound before her audio is the last reply's
    turn[stage] = at;
    changed();
  };
  /** He spoke again: a second final, or SpeechStarted. `busy`: her reply is still on its way (thinking or speaking). */
  const spokeAgain = (at, busy) => {
    const last = turns.at(-1);
    if (!last || !isTime(at) || at < last.heard) return;
    const sound = isTime(last.firstSound) ? last.firstSound : last.firstAudio;
    if (!isTime(sound)) { if (busy === true) last.againBefore = true; }
    else if (at >= sound && at - sound <= SPOKE_AGAIN_AFTER_MS) last.againAfter = true;
    changed();
  };
  /** The playing turn ends: if her first sound was not measured, it is marked cut and left out of "usual". */
  const close = () => {
    const turn = current;
    current = null;
    if (!held(turn) || isTime(turn.firstSound)) return;
    turn.cut = true;
    changed();
  };
  return Object.freeze({
    /** His final became a turn: the cut-off sign is checked on the turn before, then a new turn starts. */
    heard(at, busy) {
      if (!isTime(at)) return;
      spokeAgain(at, busy);
      turns.push({ heard: at, claimed: false, againBefore: false, againAfter: false });
      while (turns.length > TIMING_TURNS_KEPT) turns.shift();
      changed();
    },
    spokeAgain,
    /**
     * The turn the page is about to send: the newest heard one, once. Null when there is none to send. It becomes the
     * playing turn; the one playing before it is closed.
     */
    claim() {
      const last = turns.at(-1);
      if (!last || last.claimed) return null;
      close();
      last.claimed = true;
      current = last;
      return last;
    },
    /**
     * No later audio is the playing turn's: call it when a turn that was not heard is sent (no claim), when a turn is
     * cut or aborted, and when a reply goes out through the browser's own voice (no audio reaches the page).
     */
    close,
    /** A step of a claimed turn; the first stamp of each stage wins. */
    mark: stamp,
    /** A `{t:'mark'}` frame from her session adapter. */
    frame(turn, event, at) {
      if (!held(turn) || !isRecord(event)) return;
      if (typeof event.model === 'string' && event.model.trim()) turn.model = event.model.trim().slice(0, 80);
      if (typeof event.effort === 'string' && event.effort.trim()) turn.effort = event.effort.trim().slice(0, 24);
      if (isCount(event.toolRounds) && event.toolRounds <= 1000) turn.toolRounds = event.toolRounds;
      if (isCount(event.promptBytes)) turn.promptBytes = event.promptBytes;
      if (MARK_STAMPS.includes(event.v)) stamp(turn, event.v, at);
    },
    /** Her audio (`firstAudio`) or her sound (`firstSound`), for the playing turn only (claimed and not closed). */
    audio(stage, at) {
      if (!current || (stage !== 'firstAudio' && stage !== 'firstSound')) return;
      stamp(current, stage, at);
    },
    line: () => shown,
    /** A copy of the turns kept, oldest first. */
    turns: () => turns.map(turn => ({ ...turn })),
  });
}
