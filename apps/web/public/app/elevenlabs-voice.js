// AUKORA — AUMA · LIVE: HER OWN VOICE OVER ELEVENLABS, WITH DEEPGRAM KEEPING THE EARS AND STAYING THE FALLBACK.
//
// WHAT THIS FILE IS. `speechSocketFor(url, deps)` wraps the socket `deps.inner(url, deps)` returns (Deepgram's, from
// /app/deepgram-voice.js) and looks exactly like it to VoiceLink (aumalive.js): the same members, the same protocol.
// Microphone frames, `reset`, `her`, `vad`, `final` and the close code (4001 too) pass through untouched: the ears are
// Deepgram's. Only her speech is taken over, and only in one voice: a `tts` whose `voice` is ELEVEN_VOICE_PICK is spoken
// by ElevenLabs Flash v2.5 (`eleven_flash_v2_5`) in the owner's custom voice; every other `tts` goes to the inner socket
// byte for byte. Playback stays Auma Live's own player: this file emits `tts_begin{id,sr:24000}`, whole 16-bit frames
// and `tts_end{id}`, exactly as the inner socket does.
//
// NOT SET UP MEANS EXACTLY AS BEFORE. Whether her voice is set up rides on an answer the page already receives: Deepgram's
// `speech_pass` answer carries one more field (`herVoice`, deploy/cloudflare/src/eleven-speech.mjs), read here from a copy
// of that answer as the inner socket reads the original. When it is not set up, this file steps aside completely: no
// request, no notice, no timer, `ready` delivered the moment the inner socket says it. The one line naming the missing
// setting is shown only in the voice list (`showHerVoiceLine`), where "Her voice" would be.
//
// THE ACCOUNT KEY NEVER COMES HERE. When it is set up, "Her voice" is put first in `ready` and made the default at once,
// and a single-use pass is asked of the edge (`POST /_host/voice {action:'speech_pass_tts'}`) in the background. The pass
// goes only into the socket URL's `single_use_token` query; it is never put in a message, a notice or a log.
//
// ONE PHRASE IN FLIGHT. Auma Live cuts her reply with `phraseCut` (below) and sends each phrase as one `tts`. Each phrase
// is spoken in a context of its own: its text with `flush`, then at once `close_context` for it (the reference: a context
// already set to flush "will continue flushing"), so whichever of the two makes ElevenLabs send the context's final, the
// page is still listening for it. The next phrase is sent only when the current one's end is known: ElevenLabs' final
// word for its context, or QUIET_BACKSTOP_MS with no audio. A short silence never ends a phrase. A phrase the backstop
// ended is recorded as NOT CONFIRMED COMPLETE (never as completed), and the reply goes on; two in a row on a socket that
// has never sent a final, and her voice steps aside for the rest of this PAGE session (`deps.session`, by default the
// module's own, so a VoiceLink reconnect does not offer it again; Deepgram speaks, she says so once). So audio is always
// known to belong to the phrase in flight, and a lost socket always knows which phrase to send again or hand to
// Deepgram. A phrase is heard only when audio of ITS context arrived.
//
// AN INTERRUPTION STOPS HER AT ONCE, AND STALE AUDIO NEVER PLAYS. A `tts_cancel`, a new turn's `first: true`, or a `tts`
// in another voice ends her turn: what is queued is dropped (the context in flight was closed when its text went out), and
// from then on audio is delivered only when its context is the phrase in flight's. Whatever the inner socket was still speaking is stopped
// before her voice speaks, so the two providers never feed the player at the same time.
//
// DEEPGRAM IS THE FALLBACK. A socket that closes or a phrase that gets no audio in 6 s gets one new pass and one new
// socket; the phrase that got no audio is sent again. If that fails too, what is left of the reply goes to the inner
// socket in order, in its own default voice, and she says so once. An `err` is never sent for a phrase Deepgram can speak.
//
// WHAT BOUNDS SPENDING. The hard cap is the provider's own usage limit on the API key (the voice list says "provider
// limit: set on the key"). The edge hands out passes against a daily ceiling by reserve-then-settle. THIS PAGE NEVER
// SPEAKS PAST ITS RESERVATION: before a phrase would take the pass's total past what the edge reserved for it, it asks the
// edge for one more slice (`speech_extend`) and sends the phrase only after a yes; on a no, that phrase and the rest of
// the reply go to Deepgram. Its reports are CUMULATIVE: each carries every character sent on the pass so far and a
// sequence number, so a lost report loses nothing; they go with keepalive, and at once when the page goes away (whatever
// is in flight). A pass whose reports could not be delivered (five failed tries, or refused) is abandoned: nothing more is
// sent on it, no report, no extension, never a final, so its whole reservation stays counted at the edge.
//
// THE DAY IS THE EDGE'S. A ceiling refusal carries the edge's `resetInSeconds`; the stop is held that long plus
// CEILING_GRACE_MS by a monotonic clock, then the edge is asked again. The page's calendar is never read. A pass reserved
// before the edge's midnight is never extended after it (`ELEVEN_SPEECH_PASS_DAY_ENDED`): it is let go (settled) and the
// phrase waits for a new pass, reckoned in the edge's new day.
//
// HER OWN VOICE IS NEVER TAKEN FOR THE OWNER'S. Every phrase she was given is kept from its acceptance (`herEcho`). Its
// end is when its audio has been HEARD: the player's play-out of every byte delivered so far (24 kHz, 16-bit), not the
// end of delivery. While she is audible, every phrase of the reply now playing is hers whatever its age; a phrase of an
// earlier reply is compared, while she is audible, up to ECHO_WINDOW_MS after its end, and leaves the list then. No count
// evicts a phrase, so text still waiting to be spoken never pushes out one that can still be heard.
//
// VOICE PERMITS NOTHING. This file moves text one way and audio the other. The only ElevenLabs address it opens is the
// `multi-stream-input` socket.
//
// NOT VERIFIED here (no real key or microphone was used): that ElevenLabs accepts the pass in the URL, answers
// `pcm_24000` as 16-bit little-endian, sends a final word per flushed and closed context, and that `close_context` right
// after the flushed text lets the whole phrase play (the reference says it continues flushing).

/** The voice id Auma Live's picker shows for her ElevenLabs voice. It is never sent to ElevenLabs. */
export const ELEVEN_VOICE_PICK = 'elevenlabs-her-voice';
export const ELEVEN_MODEL_ID = 'eleven_flash_v2_5';
/** What VoiceLink's player is told the speech is sampled at (`output_format=pcm_24000`). */
export const ELEVEN_SAMPLE_RATE = 24000;
export const SPEECH_ROUTE = '/_host/voice';
/** The exact body deepgram-voice.js asks its pass with; its answer says whether her voice is set up. */
export const DEEPGRAM_PASS_BODY = JSON.stringify({ action: 'speech_pass' });
export const ELEVEN_PASS_ACTION = 'speech_pass_tts';
export const ELEVEN_USAGE_ACTION = 'speech_usage';
export const ELEVEN_EXTEND_ACTION = 'speech_extend';
/** The edge's answer to an extension of a pass reserved before its midnight: the pass is let go, a new one is asked. */
export const PASS_DAY_ENDED = 'ELEVEN_SPEECH_PASS_DAY_ENDED';
/** A pass request is given this long. */
export const ELEVEN_PASS_TIMEOUT_MS = 5000;
/** An idle socket that closed is reopened by a `vad` at most this often. */
export const REOPEN_SPACING_MS = 10000;
/** A phrase that gets no audio within this long counts as unanswered. */
export const FIRST_AUDIO_MS = 6000;
/** A phrase whose audio has begun and then stops this long with no final from ElevenLabs is ended as NOT confirmed. */
export const QUIET_BACKSTOP_MS = 6000;
/** A ceiling stop is held this long past the edge's own `resetInSeconds`. */
export const CEILING_GRACE_MS = 10000;
/** The longest line a notice carries. */
export const NOTICE_MAX_CHARS = 160;
/** A usage report that failed is sent again after this long, this many times at most. */
export const REPORT_RETRY_MS = 10000;
export const REPORT_ATTEMPTS = 5;
/** Her phrases are her own voice coming back while audible, and this long after their end. */
export const ECHO_TAIL_MS = 1500;
/** A phrase of an EARLIER reply is compared with, while she is audible, for this long after its end; then it is dropped. */
export const ECHO_WINDOW_MS = 30000;
/** Bytes of her audio the player plays in one second (24,000 samples of 16 bits). */
const BYTES_PER_SECOND = 24000 * 2;
export const ELEVEN_ERROR_KINDS = Object.freeze(['mint', 'open', 'first_audio', 'closed', 'ceiling', 'unconfirmed']);
/** What the voice list says about the hard cap: the provider's own, set on the key. Never a number this app cannot know. */
export const PROVIDER_LIMIT_HINT = 'provider limit: set on the key';
export const HER_VOICE_HINT = `ElevenLabs Flash v2.5 · ${PROVIDER_LIMIT_HINT}`;

const SOCKET_BASE = 'wss://api.elevenlabs.io/v1/text-to-speech/';
const PASS_RE = /^[A-Za-z0-9._~-]{8,512}$/;
const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESERVATION_RE = /^\d{4}-\d{2}-\d{2}\.[1-9][0-9]{0,6}$/;
const SETTING_NAMES = Object.freeze(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
const CEILING_NAMES = Object.freeze(['ELEVENLABS_MAX_CHARS_PER_DAY', 'ELEVENLABS_MAX_COST_PER_DAY']);
const REPORT_COUNT_MAX = 10000;
const SEQ_MAX = 1000000000;
const RESET_MAX_S = 86400;

/** The lines she says about her voice, exactly. */
export const ELEVEN_NOTICES = Object.freeze({
  speaking: 'Her ElevenLabs voice is speaking.',
  didNotAnswer: 'ElevenLabs did not answer. Deepgram is speaking this reply.',
  notConfirming: 'Her voice is not confirming the end of phrases; Deepgram is speaking.',
});
/** @param {string} name - the setting whose ceiling is reached. @returns {string} the notice. */
export const ceilingNotice = name => `Today's ElevenLabs ceiling is reached (${name}). Deepgram is speaking.`;
const are = names => `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} missing`;
/** The voice list's line when her voice is not set up. @param {string[]} names - the missing settings. */
export const unconfiguredLine = names => `Her voice is not set up: ${are(names)}`;
/** The voice list's line when this app's ceiling stopped her voice for the day. */
export const ceilingLine = name => `Her voice: today's ceiling is reached (${name})`;
const count = value => Math.round(value).toLocaleString('en-US');
/** The page session: what lasts across every voice socket this page makes (VoiceLink makes one on each connect). */
const PAGE_SESSION = { steppedAside: false };
/** The voice list's line for her voice today, by this app's own count. Never a guarantee: the hard cap is the key's. */
export function usageLine(chars, pricePer1k) {
  return `Her voice today: ${count(chars)} characters by this app's count (estimate $${(chars / 1000 * pricePer1k).toFixed(2)})`;
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAmount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const clampInt = (value, max) => Math.max(0, Math.min(max, Math.round(value)));

// ---- cadence ----
const SENTENCE_END = /[.!?…]+["'”’»)\]]?(?=\s)/g;
const CLAUSE_END = /[,;:—](?=\s)/g;
/**
 * Where to cut the next phrase out of what she has written so far. Pure. A sentence end FOLLOWED BY WHITESPACE (never
 * the end of what has arrived: "3." waits for what follows); else a clause mark followed by whitespace once the piece is
 * 24 characters (first phrase) or 60 (later); else, past 120 (first) or 220 (later), the last space before that. The first
 * phrase takes the EARLIEST cut, so she starts while the rest is written; later phrases take the LATEST one available.
 * @param {string} tail - the text not yet spoken.
 * @param {boolean} first - whether this is the turn's first phrase.
 * @returns {number} the cut index (the phrase is `tail.slice(0, cut)`), or 0 to wait.
 */
export function phraseCut(tail, first) {
  if (typeof tail !== 'string' || tail.length === 0) return 0;
  let cut = 0;
  for (const match of tail.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (end < 2) continue;
    cut = end;
    if (first) return cut;
  }
  if (cut > 0) return cut;
  const minimum = first ? 24 : 60;
  for (const match of tail.matchAll(CLAUSE_END)) {
    const end = match.index + match[0].length;
    if (end < minimum) continue;
    cut = end;
    if (first) return cut;
  }
  if (cut > 0) return cut;
  const hard = first ? 120 : 220;
  if (tail.length > hard) {
    const space = tail.lastIndexOf(' ', hard - 1);
    if (space > 0) return space;
  }
  return 0;
}

// ---- provider wording: the only two places that know ElevenLabs' messages ----
/**
 * A message to ElevenLabs. @param {{kind:'text'|'close', context:string, text?:string}} step - what to say.
 * @returns {string} the frame.
 */
export function toProvider(step) {
  if (step.kind === 'text') return JSON.stringify({ text: step.text, context_id: step.context, flush: true });
  return JSON.stringify({ context_id: step.context, close_context: true });
}
/**
 * A message from ElevenLabs, read leniently (the reference and the guide spell the fields differently).
 * @param {unknown} data - the frame.
 * @returns {{context: string|null, audio: string|null, final: boolean}|null} what it says, or null.
 */
export function fromProvider(data) {
  if (typeof data !== 'string') return null;
  let message; try { message = JSON.parse(data); } catch { return null; }
  if (!isRecord(message)) return null;
  const context = typeof message.contextId === 'string' ? message.contextId
    : typeof message.context_id === 'string' ? message.context_id : null;
  const audio = typeof message.audio === 'string' && message.audio.length > 0 ? message.audio : null;
  return { context, audio, final: message.isFinal === true || message.is_final === true };
}

/**
 * The socket for one pass. @param {string} voiceId - the owner's voice. @param {string} pass - the single-use pass.
 * @returns {string} the URL.
 */
export function elevenSocketUrl(voiceId, pass) {
  return `${SOCKET_BASE}${voiceId}/multi-stream-input?model_id=${ELEVEN_MODEL_ID}&output_format=pcm_${ELEVEN_SAMPLE_RATE}`
    + `&inactivity_timeout=180&auto_mode=true&single_use_token=${pass}`;
}

/**
 * What the `herVoice` field of Deepgram's pass answer says. Absent: neither setting is present, so both are missing.
 * @param {unknown} value - the field.
 * @returns {{configured: true}|{configured: false, missing: string[]}|null} the state, or null when it cannot be read.
 */
export function readHerVoiceField(value) {
  if (value === undefined) return { configured: false, missing: [...SETTING_NAMES] };
  if (isRecord(value) && value.configured === true && Object.keys(value).length === 1) return { configured: true };
  if (isRecord(value) && value.configured === false && Array.isArray(value.missing) && Object.keys(value).length === 2) {
    const missing = SETTING_NAMES.filter(name => value.missing.includes(name));
    if (missing.length > 0 && missing.length === value.missing.length) return { configured: false, missing };
  }
  return null;
}

/**
 * What an edge refusal means. @param {number} status - the HTTP status. @param {unknown} body - its JSON.
 * @returns {{ceiling: false}|{ceiling: true, sentence: string, line: string, resetInSeconds: number}} a ceiling and how
 * long, by the edge's own clock, until its day ends; or not a ceiling.
 */
export function refusalNotice(status, body) {
  if (status === 429 && isRecord(body) && body.code === 'ELEVEN_SPEECH_CEILING' && CEILING_NAMES.includes(body.setting)
    && typeof body.day === 'string' && DAY_RE.test(body.day)
    && Number.isSafeInteger(body.resetInSeconds) && body.resetInSeconds >= 0 && body.resetInSeconds <= RESET_MAX_S) {
    return { ceiling: true, sentence: ceilingNotice(body.setting), line: ceilingLine(body.setting), resetInSeconds: body.resetInSeconds };
  }
  return { ceiling: false };
}

/** A good answer to `speech_extend` for `reservation`, or null. */
function readExtension(body, reservation) {
  if (!isRecord(body) || body.ok !== true || body.action !== ELEVEN_EXTEND_ACTION || body.reservation !== reservation) return null;
  return Number.isSafeInteger(body.reserved) && body.reserved >= 1 ? { reserved: body.reserved } : null;
}

/** A good answer from the edge, or null. */
function readGrant(body) {
  if (!isRecord(body) || body.ok !== true || body.provider !== 'elevenlabs' || body.modelId !== ELEVEN_MODEL_ID) return null;
  if (typeof body.pass !== 'string' || !PASS_RE.test(body.pass)) return null;
  if (typeof body.voiceId !== 'string' || !VOICE_ID_RE.test(body.voiceId)) return null;
  if (typeof body.reservation !== 'string' || !RESERVATION_RE.test(body.reservation)) return null;
  const usage = body.usage;
  if (!isRecord(usage) || typeof usage.day !== 'string' || !DAY_RE.test(usage.day)
    || !['chars', 'counted', 'maxChars', 'cost', 'maxCost', 'pricePer1k'].every(name => isAmount(usage[name]))
    || !Number.isSafeInteger(usage.slice) || usage.slice < 1) return null;
  return { pass: body.pass, voiceId: body.voiceId, reservation: body.reservation,
    usage: { day: usage.day, chars: usage.chars, counted: usage.counted, maxChars: usage.maxChars, maxCost: usage.maxCost,
      pricePer1k: usage.pricePer1k, slice: usage.slice } };
}

function decodeAudio(base64) {
  try {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  } catch { return null; }
}

/**
 * The voice list's line about her voice, put first in the list (Auma Live calls this when it fills the list and when the
 * owner opens it). Nothing when there is nothing to say.
 * @param {Element|null} list - the voice list.
 * @param {{herVoiceLine?: string|null}|null} socket - VoiceLink's socket.
 */
export function showHerVoiceLine(list, socket) {
  if (!list || typeof list.querySelector !== 'function') return;
  list.querySelector('[data-her-voice-line]')?.remove();
  let line = null;
  try { line = socket?.herVoiceLine ?? null; } catch { line = null; }
  if (typeof line !== 'string' || !line || !list.ownerDocument) return;
  const node = list.ownerDocument.createElement('span');
  node.className = 'alv-vhint';
  node.setAttribute('data-her-voice-line', '');
  node.textContent = line.slice(0, 200);
  node.title = node.textContent;
  list.prepend(node);
}

/**
 * The socket VoiceLink opens: the inner socket, with her speech taken over when ElevenLabs is set up.
 * @param {string} url - the sidecar URL VoiceLink built.
 * @param {object} deps - `inner` (the factory to wrap, `voiceSocketFor`), and for tests `WebSocketImpl`, `fetchImpl`,
 * `monotonic` (elapsed time in ms; never a calendar), `setTimer`, `clearTimer`, `pageEvents`, `session` (what lasts
 * across this page's voice sockets; by default the module's own) (all passed to the inner factory too, with `now` and
 * `BroadcastChannelImpl`).
 * @returns {object} the socket.
 */
export function speechSocketFor(url, deps = {}) {
  if (typeof deps.inner !== 'function') throw new TypeError('speechSocketFor needs the inner socket factory');
  const WebSocketImpl = deps.WebSocketImpl ?? globalThis.WebSocket;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  // Elapsed time only: a page clock that is wrong, or is changed, changes nothing in this file.
  const mono = deps.monotonic ?? (() => globalThis.performance.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle));

  // WHETHER HER VOICE IS SET UP: read from a copy of Deepgram's pass answer while the inner socket reads the original.
  // The inner socket gets the very promise the fetch returned, so it waits not one step longer than it would alone.
  let herVoice = null;
  const observePass = (response) => {
    if (!response || response.ok !== true || typeof response.clone !== 'function') return;
    let copy; try { copy = response.clone(); } catch { return; }
    copy.json().then((body) => {
      if (isRecord(body) && body.ok === true && body.provider === 'deepgram') herVoice = readHerVoiceField(body.herVoice);
    }, () => {});
  };
  const observingFetch = (path, init) => {
    const pending = fetchImpl(path, init);
    if (path === SPEECH_ROUTE && init?.body === DEEPGRAM_PASS_BODY && typeof pending?.then === 'function') pending.then(observePass, () => {});
    return pending;
  };
  const inner = deps.inner(url, { ...deps, fetchImpl: observingFetch });

  const socket = { binaryType: 'arraybuffer', onopen: null, onmessage: null, onclose: null, onerror: null };
  let closed = false;
  Object.defineProperty(socket, 'readyState', { get: () => (closed ? 3 : inner.readyState), enumerable: true });
  Object.defineProperty(socket, 'cloud', { get: () => inner.cloud ?? null, enumerable: true });

  let readySeen = false;
  let chosen = false;            // her voice is in the picker
  let innerDefault = '';         // the inner socket's own default voice, for the fallback
  let given = null;              // the day's usage the edge gave with the current pass
  let reservation = null;        // the current pass's reservation
  let reservedOnPass = 0;        // characters the edge has reserved for the current pass (its slice, and each extension)
  let sentOnPass = 0;            // characters sent on the current pass: never more than reservedOnPass
  let ceilingStop = null;        // { until, sentence, line }: held by elapsed time until the edge's day ended, + grace
  // Her voice did not confirm the end of phrases: Deepgram speaks for this PAGE session, whatever socket VoiceLink opens next.
  const session = isRecord(deps.session) ? deps.session : PAGE_SESSION;
  let eleven = null;             // the ElevenLabs socket
  let elevenOpen = false;
  let elevenGen = 0;
  let opening = false;           // a pass is being asked for
  let extending = false;         // one more slice is being asked for
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let spoke = false;
  let contextSerial = 0;
  let turn = null;               // { phrases, reconnects, fellBack, noticed, firstTextAt, firstAudioMs, sentAny }
  let inflight = null;           // the one phrase sent and not yet ended
  const innerHeld = new Map();   // ids handed to the inner socket while hers is offered, not yet ended -> { begun, hers }
  let innerCancels = 0;          // cancels the wrapper sent the inner socket itself: their tts_cancelled is not the app's
  let odd = null;                // a byte held back so every frame is whole samples
  let audioWait = null;
  let quiet = null;
  let finalsSeen = false;        // this socket has sent a final for a phrase
  let backstopsInRow = 0;        // phrases in a row this socket let the quiet backstop end
  const echoes = [];             // { id, text, at, reply, heardBy, endedAt }: every phrase she was given (bounds: noteEcho)
  let replySerial = 0;           // the reply now playing
  let playhead = Number.NEGATIVE_INFINITY;   // when the player will have played every byte of hers delivered so far
  const reports = new Map();     // reservation ('' for none) -> its usage: cumulative characters, and what is still to report
  const abandoned = new Set();   // reservations nothing more is sent on: never settled, their whole reservation stays counted
  let reportTimer = null;
  const pageEvents = deps.pageEvents ?? (typeof globalThis.addEventListener === 'function' ? globalThis : null);

  const deliver = (data) => { if (!closed) { try { socket.onmessage?.({ data }); } catch { /* the app's handler is its own */ } } };
  const say = message => deliver(JSON.stringify(message));
  const notice = sentence => say({ t: 'speech_notice', say: String(sentence).slice(0, NOTICE_MAX_CHARS) });
  const innerSend = (data) => { try { inner.send(data); } catch { /* the inner close says it */ } };
  const clearAudioWait = () => { if (audioWait !== null) { clearTimer(audioWait); audioWait = null; } };
  const clearQuiet = () => { if (quiet !== null) { clearTimer(quiet); quiet = null; } };
  const queued = t => t.phrases.some(phrase => phrase.state === 'queued');

  // ---- the ceiling: held by elapsed time for as long as the edge said its day has left, never by the page's calendar ----
  const ceilingHeld = () => {
    if (ceilingStop !== null && mono() >= ceilingStop.until) ceilingStop = null;
    return ceilingStop !== null;
  };
  const holdCeiling = (refusal) => {
    ceilingStop = { until: mono() + refusal.resetInSeconds * 1000 + CEILING_GRACE_MS, sentence: refusal.sentence, line: refusal.line };
  };
  const stopSentence = () => (ceilingHeld() ? ceilingStop.sentence : ELEVEN_NOTICES.didNotAnswer);

  // ---- her own voice coming back ----
  // A phrase's END is when its audio has been HEARD: `playhead` is when the player will have played every byte of hers
  // delivered so far (it plays them in order, in real time), and a phrase's `heardBy` is the playhead after its last
  // chunk. Bounded by the reply and by time: every phrase of the reply now playing is kept for the whole reply (its length
  // bounds them); a phrase of an earlier reply leaves the list ECHO_WINDOW_MS after its end. A phrase whose audio has not
  // ended is never dropped, whatever comes after it.
  const noteEcho = (id, text) => {
    const at = mono();
    for (let index = echoes.length - 1; index >= 0; index -= 1) {
      const entry = echoes[index];
      if (entry.reply !== replySerial && entry.endedAt !== null && at - entry.endedAt > ECHO_WINDOW_MS) echoes.splice(index, 1);
    }
    echoes.push({ id, text, at, reply: replySerial, heardBy: null, endedAt: null });
  };
  const noteHeard = (id, bytes) => {
    playhead = Math.max(mono(), playhead) + bytes / BYTES_PER_SECOND * 1000;
    for (const entry of echoes) if (entry.id === id) entry.heardBy = playhead;
  };
  const endEcho = (entry) => { if (entry.endedAt === null) entry.endedAt = Math.max(mono(), entry.heardBy ?? 0); };
  const echoEnded = (id) => { for (const entry of echoes) if (entry.id === id) endEcho(entry); };
  const echoesEnded = () => { for (const entry of echoes) endEcho(entry); };
  /**
   * Whether a transcript is one of her phrases coming back: each phrase is compared on its own while its audio may still
   * play, ECHO_TAIL_MS after it was heard to its end, and while she is audible: any phrase of the reply now playing,
   * whatever its age, and one of an earlier reply up to ECHO_WINDOW_MS after its end. `isSelfEcho` (aumalive-duplex.js)
   * keeps its rule that one or two words of the owner's own still get through.
   */
  socket.herEcho = (transcript, audible, isSelfEcho) => {
    if (typeof isSelfEcho !== 'function' || typeof transcript !== 'string') return false;
    const at = mono();
    return echoes.some((entry) => {
      const open = entry.endedAt === null || at - entry.endedAt <= ECHO_TAIL_MS
        || (audible === true && (entry.reply === replySerial || at - entry.endedAt <= ECHO_WINDOW_MS));
      return open && isSelfEcho(transcript, entry.text) === true;
    });
  };

  // ---- usage: CUMULATIVE per pass, with a sequence number; a lost report loses nothing, the next carries the truth ----
  const freshReport = key => ({ reservation: key || null, sent: 0, acked: 0, seq: 0, turns: 0,
    firstAudio: { count: 0, sumMs: 0, maxMs: 0 }, errors: {}, final: false, finalAcked: false, attempts: 0, inFlight: 0, waiting: false });
  // An abandoned pass gets a record nobody sends: nothing more goes to the edge on it, never a final.
  const reportFor = (key) => {
    if (key && abandoned.has(key)) return freshReport(key);
    let entry = reports.get(key);
    if (!entry) { entry = freshReport(key); reports.set(key, entry); }
    return entry;
  };
  const currentReport = () => reportFor(reservation ?? '');
  const bump = (kind) => { const entry = currentReport(); entry.errors[kind] = (entry.errors[kind] ?? 0) + 1; };
  const telemetry = entry => entry.turns > 0 || entry.firstAudio.count > 0 || Object.keys(entry.errors).length > 0;
  const hasNews = entry => entry.sent > entry.acked || telemetry(entry) || (entry.final && !entry.finalAcked);
  const abandon = (key) => { if (key) abandoned.add(key); reports.delete(key); };
  // The report: the pass's whole total so far (never cleared here), and the turns, first audio and errors since the last.
  const takeReport = (entry) => {
    const errors = {};
    for (const kind of ELEVEN_ERROR_KINDS) if (entry.errors[kind] > 0) errors[kind] = clampInt(entry.errors[kind], REPORT_COUNT_MAX);
    entry.seq = Math.min(SEQ_MAX, entry.seq + 1);
    const body = { action: ELEVEN_USAGE_ACTION, reservation: entry.reservation, seq: entry.seq, chars: entry.sent,
      turns: clampInt(entry.turns, REPORT_COUNT_MAX), firstAudio: { ...entry.firstAudio }, errors, final: entry.final && entry.reservation !== null };
    entry.turns = 0; entry.firstAudio = { count: 0, sumMs: 0, maxMs: 0 }; entry.errors = {};
    return body;
  };
  const putBack = (entry, body) => {
    entry.turns += body.turns;
    entry.firstAudio.count += body.firstAudio.count; entry.firstAudio.sumMs += body.firstAudio.sumMs;
    entry.firstAudio.maxMs = Math.max(entry.firstAudio.maxMs, body.firstAudio.maxMs);
    for (const [kind, value] of Object.entries(body.errors)) entry.errors[kind] = (entry.errors[kind] ?? 0) + value;
  };
  // A report that failed waits REPORT_RETRY_MS, then the pass's whole total goes again with what came meanwhile.
  const retryReports = () => {
    if (reportTimer !== null) return;
    reportTimer = setTimer(() => {
      reportTimer = null;
      for (const entry of reports.values()) entry.waiting = false;
      flushReports();
    }, REPORT_RETRY_MS);
  };
  const sendReport = (key, entry) => {
    const body = takeReport(entry);
    entry.inFlight += 1;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimer(() => controller?.abort(), ELEVEN_PASS_TIMEOUT_MS);
    const settle = (delivered, definite) => {
      clearTimer(timer);
      entry.inFlight -= 1;
      if (reports.get(key) !== entry) return;            // settled or abandoned meanwhile
      if (delivered) {
        entry.attempts = 0;
        entry.acked = Math.max(entry.acked, body.chars);
        if (body.final) entry.finalAcked = true;
        if (entry.finalAcked || (key === '' && !hasNews(entry))) { reports.delete(key); return; }
        if (hasNews(entry)) flushReports();
        return;
      }
      // Refused outright (malformed, stale, the session lapsed): abandoned, so its whole reservation stays counted.
      if (definite) { abandon(key); return; }
      putBack(entry, body);
      entry.attempts += 1;
      entry.waiting = true;
      // Given up after REPORT_ATTEMPTS: abandoned likewise.
      if (entry.attempts >= REPORT_ATTEMPTS) { abandon(key); return; }
      retryReports();
    };
    void Promise.resolve().then(() => fetchImpl(SPEECH_ROUTE, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), keepalive: true, ...(controller ? { signal: controller.signal } : {}),
    })).then(
      response => settle(response?.ok === true, response?.status >= 400 && response?.status < 500 && response.status !== 408 && response.status !== 429),
      () => settle(false, false),
    );
  };
  const flushReports = () => { for (const [key, entry] of reports) if (entry.inFlight === 0 && !entry.waiting && hasNews(entry)) sendReport(key, entry); };
  // THE PAGE GOES AWAY (a reload, a closed tab): the pass in use is settled at once with its whole total, and every report
  // still held goes now, even beside one already on its way. Every report carries keepalive, so it outlives the page. A
  // page that comes back from the back-forward cache never speaks on the pass it settled: it asks for a new one.
  const onPageHide = () => {
    if (closed) return;
    if (reservation !== null) currentReport().final = true;
    for (const [key, entry] of reports) if (hasNews(entry)) sendReport(key, entry);
    if (eleven) { reservation = null; detachEleven(); }
  };

  // ---- asking the edge: a pass, or one more slice ----
  const askEdge = async (body, read) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const late = new Promise((resolve) => {
      timer = setTimer(() => { timer = null; controller?.abort(); resolve({ kind: 'failed' }); }, ELEVEN_PASS_TIMEOUT_MS);
    });
    const asked = (async () => {
      try {
        const response = await fetchImpl(SPEECH_ROUTE, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), ...(controller ? { signal: controller.signal } : {}),
        });
        const answer = await response.json().catch(() => null);
        if (response.ok) {
          const value = read(answer);
          return value ? { kind: 'ok', value } : { kind: 'refused', status: 502, body: null };
        }
        return { kind: 'refused', status: response.status, body: answer };
      } catch { return { kind: 'failed' }; }
    })();
    try { return await Promise.race([asked, late]); } finally { if (timer !== null) clearTimer(timer); }
  };

  // ---- the ElevenLabs socket ----
  // A pass's socket is done: its reservation gets its final report, so the edge settles it to what was spoken.
  const dropSocket = () => {
    eleven = null; elevenOpen = false; elevenGen += 1; finalsSeen = false; backstopsInRow = 0;
    if (reservation !== null) { reportFor(reservation).final = true; reservation = null; flushReports(); }
    reservedOnPass = 0;
  };
  function detachEleven() {
    const old = eleven;
    dropSocket();
    if (old) { old.onopen = old.onmessage = old.onerror = old.onclose = null; try { old.close(); } catch { /* closed */ } }
  }
  const openSocket = (grant) => {
    detachEleven();
    given = grant.usage; sentOnPass = 0; reservation = grant.reservation; reservedOnPass = grant.usage.slice;
    reportFor(reservation);
    const gen = elevenGen;
    let ws;
    try { ws = new WebSocketImpl(elevenSocketUrl(grant.voiceId, grant.pass)); } catch { bump('open'); dropSocket(); afterLoss(); return; }
    eleven = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { if (gen !== elevenGen || closed) return; elevenOpen = true; pump(); };
    ws.onmessage = (event) => { if (gen === elevenGen) onProvider(event?.data); };
    ws.onerror = () => { /* the close says it */ };
    ws.onclose = () => {
      if (gen !== elevenGen) return;
      const wasOpen = elevenOpen;
      dropSocket();
      if (turn && !turn.fellBack && (inflight || queued(turn))) recover(wasOpen ? 'closed' : 'open');
      else if (!wasOpen) bump('open');
    };
  };
  // A pass for a new socket. A failure while a turn waits hands what is left of it to the inner socket.
  const connect = async () => {
    if (opening || eleven || closed || !chosen || session.steppedAside) return;
    if (ceilingHeld()) { afterLoss(); return; }
    opening = true; lastAttemptAt = mono();
    const result = await askEdge({ action: ELEVEN_PASS_ACTION }, readGrant);
    opening = false;
    if (closed) {
      // A pass given after the socket closed is never used: it is settled at nothing.
      if (result.kind === 'ok') { reportFor(result.value.reservation).final = true; flushReports(); }
      return;
    }
    if (result.kind === 'ok') {
      openSocket(result.value);
      if (!spoke) { spoke = true; notice(ELEVEN_NOTICES.speaking); }
      return;
    }
    bump('mint');
    if (result.kind === 'refused') {
      const refusal = refusalNotice(result.status, result.body);
      if (refusal.ceiling) holdCeiling(refusal);
    }
    afterLoss();
  };
  function afterLoss() {
    if (turn && !turn.fellBack && (inflight || queued(turn))) fallBack(turn, stopSentence());
  }
  // ONE MORE SLICE, before a phrase would take the pass past its reservation. The phrase goes only after the edge's yes;
  // on a no (the ceiling, the rate, an error) it and the rest of the reply go to Deepgram; on "the pass's day has ended",
  // a new pass.
  const extendPass = async () => {
    extending = true;
    clearAudioWait();
    const gen = elevenGen;
    const forPass = reservation;
    const before = reservedOnPass;
    const result = await askEdge({ action: ELEVEN_EXTEND_ACTION, reservation: forPass }, answer => readExtension(answer, forPass));
    extending = false;
    if (closed) return;
    if (gen !== elevenGen || reservation !== forPass) { pump(); return; }   // another pass is in use now: it decides
    if (result.kind === 'ok' && result.value.reserved > before) { reservedOnPass = result.value.reserved; pump(); return; }
    // The pass was reserved before the edge's midnight: it is never extended after it. It is let go (its final settles it
    // on its own day) and the phrase waits for a new pass, reckoned in the edge's new day (one try, as for a lost socket).
    if (result.kind === 'refused' && result.status === 409 && isRecord(result.body) && result.body.code === PASS_DAY_ENDED) {
      detachEleven(); pump(); return;
    }
    const refusal = result.kind === 'refused' ? refusalNotice(result.status, result.body) : { ceiling: false };
    bump(refusal.ceiling ? 'ceiling' : 'mint');
    // At the ceiling the pass is spent: it is settled now, and a new one is asked for once the edge's day has ended.
    if (refusal.ceiling) { holdCeiling(refusal); detachEleven(); }
    if (turn && !turn.fellBack && (inflight || queued(turn))) fallBack(turn, refusal.ceiling ? refusal.sentence : ELEVEN_NOTICES.didNotAnswer);
  };

  // ---- phrases ----
  const beginToApp = id => say({ t: 'tts_begin', id, sr: ELEVEN_SAMPLE_RATE });
  const endToApp = (id) => { say({ t: 'tts_end', id }); echoEnded(id); };
  const armAudioWait = () => {
    if (audioWait !== null) return;
    audioWait = setTimer(() => {
      audioWait = null;
      if (!extending && turn && !turn.fellBack && (inflight || queued(turn))) recover('first_audio');
    }, FIRST_AUDIO_MS);
  };
  // The phrase in flight goes back to the queue when none of its audio arrived; when some did, it is ended, never resent.
  const settleInflight = () => {
    const phrase = inflight;
    inflight = null; odd = null;
    if (!phrase) return;
    if (phrase.state === 'begun') { endToApp(phrase.id); phrase.state = 'ended'; } else phrase.state = 'queued';
  };
  function ensureSocket() {
    if (eleven || opening) return;
    if (turn.reconnects >= 1) { fallBack(turn, stopSentence()); return; }
    turn.reconnects += 1;
    armAudioWait();
    void connect();
  }
  // ONE PHRASE IN FLIGHT: the next is sent only once the current one has ended, and never past the pass's reservation.
  function pump() {
    if (closed || !turn || turn.fellBack || inflight || extending) return;
    const next = turn.phrases.find(phrase => phrase.state === 'queued');
    if (!next) { flushReports(); return; }
    if (!eleven) { ensureSocket(); return; }
    if (!elevenOpen) return;
    const text = `${next.text} `;
    const chars = [...text].length;
    if (sentOnPass + chars > reservedOnPass) {
      // Nothing more is asked on an abandoned pass: it is let go (never settled) and a new pass is asked for.
      if (abandoned.has(reservation)) { detachEleven(); ensureSocket(); return; }
      void extendPass();
      return;
    }
    contextSerial += 1;
    const context = `auma-${String(contextSerial)}`;
    try { eleven.send(toProvider({ kind: 'text', context, text })); } catch { return; }
    next.state = 'sent'; next.context = context; inflight = next;
    sentOnPass += chars; currentReport().sent += chars; turn.sentAny = true;
    // Closed at once, and only here: a context set to flush "will continue flushing" (the reference), and the phrase stays
    // in flight until its final, so a final that the close brings is heard. No context is ever closed twice.
    try { eleven.send(toProvider({ kind: 'close', context })); } catch { /* the socket's close says it */ }
    if (turn.firstTextAt === null) turn.firstTextAt = mono();
    armAudioWait();
  }
  // HER VOICE STEPS ASIDE for the rest of this page session: the rest of the reply, and every later one, is Deepgram's.
  const stepAside = () => {
    session.steppedAside = true;
    if (turn && !turn.fellBack) fallBack(turn, ELEVEN_NOTICES.notConfirming);
    else { detachEleven(); notice(ELEVEN_NOTICES.notConfirming); }
  };
  // The phrase in flight ends: by ElevenLabs' final for it (confirmed), or by the quiet backstop (NOT confirmed complete).
  const endInflight = (confirmed) => {
    clearQuiet(); clearAudioWait();
    const phrase = inflight;
    if (!phrase) return;
    inflight = null; odd = null;
    if (phrase.state === 'sent') beginToApp(phrase.id);                // ended with no audio: the app pairs begin and end
    endToApp(phrase.id);
    phrase.state = confirmed ? 'ended' : 'unconfirmed';
    if (!confirmed) {
      bump('unconfirmed');
      backstopsInRow += 1;
      if (backstopsInRow >= 2 && !finalsSeen) { stepAside(); return; }
    }
    pump();
  };
  // A SOCKET LOST, OR A PHRASE UNANSWERED: one new pass and one new socket; the phrase that got no audio is sent again.
  function recover(kind) {
    bump(kind);
    clearAudioWait(); clearQuiet();
    detachEleven();
    const t = turn;
    if (!t || t.fellBack) return;
    settleInflight();
    if (!queued(t)) { flushReports(); return; }
    if (t.reconnects >= 1 || ceilingHeld()) { fallBack(t, stopSentence()); return; }
    t.reconnects += 1;
    armAudioWait();
    void connect();
  }
  const toInner = (message) => {
    innerHeld.set(message.id, { begun: false, hers: true });
    innerSend(JSON.stringify({ ...message, voice: innerDefault }));
  };
  // THE INNER SOCKET SPEAKS WHAT ELEVENLABS DID NOT, in order, in its own default voice. ElevenLabs is closed first, so
  // the player is fed by one provider at a time; the ids the app holds keep theirs.
  function fallBack(t, sentence) {
    t.fellBack = true;
    clearAudioWait(); clearQuiet();
    detachEleven();
    settleInflight();
    for (const phrase of t.phrases) {
      if (phrase.state !== 'queued') continue;
      phrase.state = 'inner';
      toInner({ t: 'tts', id: phrase.id, text: phrase.text, speed: 1, first: false });
    }
    if (!t.noticed) { t.noticed = true; notice(sentence); }
    flushReports();
  }
  // What the inner socket still speaks while hers takes over (a preview of another voice, or an old reply's fallback):
  // ended toward the app and cancelled, so the two never feed the player at the same time. Its tts_cancelled is ours.
  const stopInner = () => {
    if (innerHeld.size === 0) return;
    for (const [id, held] of innerHeld) { if (!held.begun) beginToApp(id); endToApp(id); }
    innerHeld.clear();
    innerCancels += 1;
    innerSend(JSON.stringify({ t: 'tts_cancel' }));
  };
  // A turn leaves: nothing more of the phrase in flight is delivered (its context was closed when its text went out), and
  // the turn is counted.
  const retire = (old) => {
    inflight = null; odd = null;
    clearAudioWait(); clearQuiet();
    if (!old) return;
    echoesEnded();
    if (old.sentAny) currentReport().turns += 1;
    flushReports();
  };
  // HER TURN ENDS WITHOUT A CANCEL FROM THE APP (a new reply, or a `tts` in another voice): every id of it the app still
  // waits for is ended toward it (begun first where it never was, as the inner socket pairs them). What the inner socket
  // speaks is stopped too when her voice takes over (`stopAll`), or when it is her own reply's fallback.
  const endTurnForApp = (stopAll) => {
    const old = turn;
    if (old) {
      if (inflight) { if (inflight.state === 'sent') beginToApp(inflight.id); endToApp(inflight.id); inflight.state = 'ended'; }
      for (const phrase of old.phrases) if (phrase.state === 'queued') { beginToApp(phrase.id); endToApp(phrase.id); phrase.state = 'ended'; }
    }
    if (stopAll || [...innerHeld.values()].some(held => held.hers)) stopInner();
    turn = null;
    retire(old);
  };
  const openTurn = () => {
    endTurnForApp(true);
    replySerial += 1;
    turn = { phrases: [], reconnects: 0, fellBack: false, noticed: false, firstTextAt: null, firstAudioMs: null, sentAny: false };
  };
  const cut = () => {
    const old = turn;
    turn = null;
    innerHeld.clear();
    retire(old);
  };
  const accept = (message, raw) => {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!Number.isFinite(message.id) || !text) { innerSend(raw); return; }
    if (message.first === true || !turn) openTurn();
    else if (!turn.fellBack) stopInner();
    const t = turn;
    noteEcho(message.id, text);
    if (t.fellBack) { toInner(message); return; }
    // Stepped aside: Deepgram speaks every later reply; she said why once already.
    if (session.steppedAside) { t.fellBack = true; t.noticed = true; toInner(message); return; }
    if (ceilingHeld()) { fallBack(t, ceilingStop.sentence); toInner(message); return; }
    t.phrases.push({ id: message.id, text, state: 'queued', context: null });
    armAudioWait();
    pump();
  };
  const deliverPcm = (chunk) => {
    let bytes = chunk;
    if (odd !== null) { const joined = new Uint8Array(bytes.length + 1); joined[0] = odd; joined.set(bytes, 1); bytes = joined; odd = null; }
    if (bytes.length % 2 === 1) { odd = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1); }
    if (bytes.length === 0) return;
    deliver(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  // Audio is delivered only for the context of the phrase in flight: an older context, or none, is discarded.
  const onProvider = (data) => {
    const message = fromProvider(data);
    if (!message || !turn || turn.fellBack || !inflight || message.context === null || message.context !== inflight.context) return;
    if (message.audio !== null) {
      const bytes = decodeAudio(message.audio);
      if (bytes && bytes.length > 0) {
        clearAudioWait();
        if (inflight.state === 'sent') {
          inflight.state = 'begun';
          beginToApp(inflight.id);
          if (turn.firstAudioMs === null && turn.firstTextAt !== null) {
            turn.firstAudioMs = clampInt(mono() - turn.firstTextAt, 60000);
            const fa = currentReport().firstAudio;
            fa.count += 1; fa.sumMs += turn.firstAudioMs; fa.maxMs = Math.max(fa.maxMs, turn.firstAudioMs);
          }
        }
        deliverPcm(bytes);
        noteHeard(inflight.id, bytes.length);
        clearQuiet();
        // A short silence never ends a phrase: only its final does, or QUIET_BACKSTOP_MS with no audio (not confirmed).
        quiet = setTimer(() => { quiet = null; endInflight(false); }, QUIET_BACKSTOP_MS);
      }
    }
    // A final reaches here only for the phrase in flight (its context closed already, its final still awaited).
    if (message.final) { finalsSeen = true; backstopsInRow = 0; endInflight(true); }
  };

  // ---- her voice is offered, or this file steps aside ----
  const offer = (ready) => {
    chosen = true;
    try { pageEvents?.addEventListener('pagehide', onPageHide); } catch { /* no page to leave */ }
    innerDefault = typeof ready.default_voice === 'string' ? ready.default_voice : '';
    const voices = Array.isArray(ready.voices) ? ready.voices : [];
    say({ ...ready, voices: [{ id: ELEVEN_VOICE_PICK, label: 'Her voice', hint: HER_VOICE_HINT, engine: 'elevenlabs' }, ...voices],
      default_voice: ELEVEN_VOICE_PICK });
    void connect();
  };
  // A `vad` passing through warms an idle socket that closed, so it is ready before she answers.
  const warm = () => {
    if (closed || session.steppedAside || eleven || opening || mono() - lastAttemptAt < REOPEN_SPACING_MS) return;
    if (ceilingHeld()) return;
    void connect();
  };
  /** The voice list's line about her voice: the missing setting, today's count by this app, or why Deepgram speaks. */
  Object.defineProperty(socket, 'herVoiceLine', {
    enumerable: true,
    get: () => {
      if (herVoice === null) return null;
      if (!herVoice.configured) return unconfiguredLine(herVoice.missing);
      if (!chosen) return null;
      if (session.steppedAside) return ELEVEN_NOTICES.notConfirming;
      if (ceilingHeld()) return ceilingStop.line;
      return given ? usageLine(given.chars + sentOnPass, given.pricePer1k) : null;
    },
  });

  const finish = () => {
    if (closed) return;
    try { pageEvents?.removeEventListener('pagehide', onPageHide); } catch { /* no page to leave */ }
    const old = turn;
    turn = null;
    retire(old);
    detachEleven();
    closed = true;
  };

  inner.onmessage = (event) => {
    const data = event?.data;
    if ((readySeen && !chosen) || typeof data !== 'string') { deliver(data); return; }
    let message = null; try { message = JSON.parse(data); } catch { /* not ours to read */ }
    if (!readySeen) {
      if (isRecord(message) && message.t === 'ready') {
        readySeen = true;
        if (message.cloud === 'Deepgram' && herVoice?.configured === true) { offer(message); return; }
      }
      deliver(data);
      return;
    }
    if (isRecord(message)) {
      if (message.t === 'vad' && message.speaking === true) warm();
      if (message.t === 'tts_cancelled' && innerCancels > 0) { innerCancels -= 1; return; }
      if (message.t === 'tts_begin' && innerHeld.has(message.id)) innerHeld.get(message.id).begun = true;
      if (message.t === 'tts_end') { innerHeld.delete(message.id); echoEnded(message.id); }
    }
    deliver(data);
  };
  inner.onerror = () => { try { socket.onerror?.(); } catch { /* the app's handler is its own */ } };
  inner.onclose = (event) => {
    finish();
    try { socket.onclose?.(event); } catch { /* the app's handler is its own */ }
  };

  socket.send = (data) => {
    if (closed) return;
    if (!chosen || typeof data !== 'string') { innerSend(data); return; }
    let message = null; try { message = JSON.parse(data); } catch { /* passed on as it is */ }
    if (isRecord(message) && message.t === 'tts') {
      if (message.voice === ELEVEN_VOICE_PICK) { accept(message, data); return; }
      // Another voice (a preview, or a Deepgram voice picked): her reply is ended first, so only one provider speaks.
      if (turn) endTurnForApp(false);
      if (Number.isFinite(message.id)) innerHeld.set(message.id, { begun: false, hers: false });
    }
    if (isRecord(message) && message.t === 'tts_cancel') cut();
    innerSend(data);
  };
  socket.close = () => {
    if (closed) return;
    finish();
    try { inner.close(); } catch { /* closed */ }
  };
  return socket;
}
