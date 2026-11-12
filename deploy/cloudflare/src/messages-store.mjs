/** Durable local messages with optional owner-provisioned Nostr signing. No relay or MLS operations occur here. */
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { bech32 } from '@scure/base'
import { AURA_INPUT_LIMITS, auraInputsComplete, computeAura } from '../../../server/aura-rules.mjs'

/** Single JSON value owned by the messages service; adapters must transact its reads and writes atomically. */
export const MESSAGES_STORAGE_KEY = 'messages:v1'
/** Hard admission limits. Capacity exhaustion never evicts conversations or idempotency records. */
export const MESSAGES_LIMITS = Object.freeze({
  stateBytes: 112 * 1024, requestBytes: 16 * 1024, contentBytes: 4096,
  conversations: 128, turns: 512, members: 64, nameBytes: 480, requestIdBytes: 128,
})
/** Limits for the caller-supplied, read-only receipt JSONL projection. */
export const PREDICTION_LIMITS = Object.freeze({ bytes: 1024 * 1024, lineBytes: 16 * 1024, rows: 10000 })
/** Opt-in probe deadlines; these do not install an executor or enable wake scheduling. */
export const WAKE_PROBE_LIMITS = Object.freeze({ defaultTimeoutMs: 5000, maxTimeoutMs: 30000 })
/** Persistable outcomes contain no callback text, errors, model output, or head claims. */
export const WAKE_PROBE_STATUSES = Object.freeze([
  'executor_unavailable', 'probe_succeeded', 'probe_blocked', 'probe_failed', 'probe_invalid',
  'probe_timeout', 'probe_cancelled', 'probe_busy', 'probe_disposed', 'probe_ready', 'probe_skipped_rest',
])

const encoder = new TextEncoder()
const LOCAL = 'microverse-local'
const VERSION = 'aukora.messages/v1'
const ID_SCHEME = 'aukora.messages.local/v1'
const SIGNED_ID_SCHEME = 'nip01-schnorr/v1'
const IDENTITY_VERSION = 'aukora.messages.identity/v1'
const HEX = /^[0-9a-f]{64}$/
const SIGNATURE = /^[0-9a-f]{128}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CONVERSATION_ID = /^[a-z0-9][a-z0-9-]{0,95}$/
const ROUTES = new Map([
  ['/aukora-messages/contacts.json', 'GET'], ['/aukora-messages/thread', 'POST'],
  ['/aukora-messages/send', 'POST'], ['/aukora-messages/add-contact', 'POST'],
])
const conversationFields = ['id', 'kind', 'name', 'npub', 'controller', 'memberNpubs', 'desiredProtocol', 'protocol', 'tier', 'mls', 'createdAt']
const turnFields = ['id', 'idScheme', 'conversationId', 'requestId', 'content', 'at', 'created_at', 'kind', 'tags', 'pubkey', 'sig', 'signatureStatus', 'delivery', 'from', 'protocol']

class MessagesError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}
const refuse = (code, status = 400) => { throw new MessagesError(code, status) }
const record = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const bytes = value => encoder.encode(value).byteLength
const fields = (value, required, optional = []) => record(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))

function probeData(value, keys) {
  if (!record(value) || Reflect.ownKeys(value).length !== keys.length) return null
  const result = {}
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) return null
    result[key] = property.value
  }
  return result
}

/**
 * Validate persisted probe metadata, including the original absent-executor representation.
 * @param {unknown} value Executor metadata read from a receipt, not a callback result.
 * @returns {boolean} Whether exactly the three permitted fields agree with a fixed outcome.
 */
export function isWakeProbeExecutor(value) {
  try {
    const data = probeData(value, ['available', 'invoked', 'status'])
    if (!data || typeof data.available !== 'boolean' || typeof data.invoked !== 'boolean'
      || !WAKE_PROBE_STATUSES.includes(data.status)) return false
    if (data.status === 'executor_unavailable') return !data.available && !data.invoked
    if (['probe_disposed', 'probe_skipped_rest'].includes(data.status)) return !data.invoked
    if (!data.available) return false
    if (['probe_busy', 'probe_ready'].includes(data.status)) return !data.invoked
    if (['probe_timeout', 'probe_cancelled'].includes(data.status)) return true
    return data.invoked
  } catch (_error) {
    return false
  }
}

function probeOutcome(value) {
  try {
    const data = probeData(value, ['status'])
    if (data?.status === 'success') return 'probe_succeeded'
    if (data?.status === 'blocked') return 'probe_blocked'
    if (data?.status === 'failed') return 'probe_failed'
  } catch (_error) { /* Invalid callback objects never expose their contents or accessors. */ }
  return 'probe_invalid'
}

/**
 * Own one optional, nonblocking probe callback. Nothing here loads credentials or performs I/O.
 * Missing runWakeProbe returns executor_unavailable. A callback receives a frozen metadata-only
 * head copy, the supplied timestamp, and an AbortSignal; it may return only {status:'success'|'blocked'|'failed'}.
 * run resolves at callback completion, deadline, or disposal, but busy and whenSettled track actual
 * callback settlement. Timeout never admits another callback, and late results cannot change a result.
 * Callers must claim durably before run, outside any retriable transaction, and retain that claim until
 * whenSettled resolves. Unknown claims after reconstruction must not be resumed or expired by a timer.
 * dispose prevents admission and aborts immediately; its promise waits for quiescence, potentially
 * indefinitely if the callback ignores cancellation. JavaScript cannot preempt a synchronous callback,
 * but a monotonic clock also rejects late completion when the timeout delivery was delayed.
 * @param {object} options Optional callback, timeoutMs (1..30000), monotonicNow, and asynchronous timer functions.
 * @returns {object} run({head,now}), available/busy getters, whenSettled(), and dispose().
 */
export function createWakeProbeRunner({ runWakeProbe, timeoutMs = WAKE_PROBE_LIMITS.defaultTimeoutMs,
  monotonicNow = () => globalThis.performance.now(),
  setTimeout: scheduleTimer = globalThis.setTimeout, clearTimeout: cancelTimer = globalThis.clearTimeout } = {}) {
  if ((runWakeProbe !== undefined && typeof runWakeProbe !== 'function')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WAKE_PROBE_LIMITS.maxTimeoutMs
    || typeof monotonicNow !== 'function' || typeof scheduleTimer !== 'function' || typeof cancelTimer !== 'function') {
    throw new TypeError('WAKE_PROBE_OPTIONS_INVALID')
  }
  const available = runWakeProbe !== undefined
  let pending = null
  let disposed = false
  const metadata = (status, invoked = false) => ({ available, invoked, status })
  const whenSettled = () => pending === null ? Promise.resolve() : pending.settled
  return {
    get available() { return available },
    get busy() { return pending !== null },
    whenSettled,
    run({ head, now }) {
      if (disposed) return Promise.resolve(metadata('probe_disposed'))
      if (!available) return Promise.resolve(metadata('executor_unavailable'))
      if (pending !== null) return Promise.resolve(metadata('probe_busy'))
      let selected = null
      if (head !== null) {
        selected = probeData(head, ['ballId', 'epoch'])
        if (!selected || typeof selected.ballId !== 'string' || !HEX.test(selected.ballId)
          || !Number.isSafeInteger(selected.epoch) || selected.epoch < 0 || Object.is(selected.epoch, -0)) {
          throw new TypeError('WAKE_PROBE_HEAD_INVALID')
        }
        Object.freeze(selected)
      }
      if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 || Object.is(now, -0)) {
        throw new TypeError('WAKE_PROBE_TIME_INVALID')
      }
      let previousTime = 0
      const monotonicTime = () => {
        const time = monotonicNow()
        if (typeof time !== 'number' || !Number.isFinite(time) || time < previousTime) {
          throw new TypeError('WAKE_PROBE_CLOCK_UNAVAILABLE')
        }
        previousTime = time
        return time
      }
      const startedAt = monotonicTime()
      const controller = new AbortController()
      let resolveResult, rejectResult, resolveSettled
      const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
      const admission = { controller, invoked: false, finished: false, timer: null,
        settled: new Promise(resolve => { resolveSettled = resolve }), finish: null }
      const clearDeadline = () => {
        if (admission.timer === null) return
        const timer = admission.timer
        admission.timer = null
        try { cancelTimer(timer) } catch (_error) { /* A later timer delivery is fenced by finished. */ }
      }
      admission.finish = status => {
        if (admission.finished) return
        admission.finished = true
        clearDeadline()
        resolveResult(metadata(status, admission.invoked))
      }
      const settle = status => {
        if (!admission.finished) {
          try {
            if (monotonicTime() - startedAt >= timeoutMs) {
              admission.finish('probe_timeout')
              controller.abort()
            }
          } catch (_error) {
            admission.finish('probe_failed')
            controller.abort()
          }
        }
        admission.finish(status)
        if (pending === admission) pending = null
        resolveSettled()
      }
      pending = admission
      try {
        admission.timer = scheduleTimer(() => {
          if (admission.finished) return
          admission.finish('probe_timeout')
          controller.abort()
        }, timeoutMs)
      } catch (_error) {
        admission.finished = true
        pending = null
        resolveSettled()
        rejectResult(Object.assign(new Error('WAKE_PROBE_TIMER_UNAVAILABLE'), { code: 'WAKE_PROBE_TIMER_UNAVAILABLE' }))
        return result
      }
      // Even a reentrant timer or disposal cannot start a callback after cancellation.
      if (admission.finished) {
        clearDeadline()
        settle('probe_cancelled')
        return result
      }
      try {
        if (monotonicTime() - startedAt >= timeoutMs) {
          admission.finish('probe_timeout')
          controller.abort()
          settle('probe_timeout')
          return result
        }
      } catch (_error) {
        admission.finished = true
        clearDeadline()
        pending = null
        resolveSettled()
        rejectResult(Object.assign(new Error('WAKE_PROBE_CLOCK_UNAVAILABLE'), { code: 'WAKE_PROBE_CLOCK_UNAVAILABLE' }))
        return result
      }
      admission.invoked = true
      let output
      try { output = runWakeProbe(Object.freeze({ head: selected, now, signal: controller.signal })) }
      catch (_error) {
        settle('probe_failed')
        return result
      }
      // Attach both observers immediately; late rejection is consumed even after timeout/disposal.
      Promise.resolve(output).then(value => settle(probeOutcome(value)), () => settle('probe_failed'))
      return result
    },
    dispose() {
      disposed = true
      if (pending !== null) {
        pending.finish('probe_cancelled')
        pending.controller.abort()
      }
      return whenSettled()
    },
  }
}

/**
 * Bound an optional trusted, read-only aura input adapter with the probe cancellation rules.
 * The adapter supplies verification metrics, never a vector; head identity and time are owned
 * by the wake caller. Missing, invalid, rejected, or timed-out metrics yield null, never scores.
 * Metric records contain only the fixed scalar fields and the shared bounded surprise-score list.
 * No production adapter is installed here. Receipt counts, mirrored vectors and organ assertions
 * cannot substitute for independently verified metrics. Call only after a durable claim commits,
 * and retain that claim until whenSettled resolves, including after a read deadline expires.
 * @param {object} options Optional readAuraInputs({head,now,signal}), timeoutMs, monotonicNow, and timers.
 * @returns {object} read({head,now}) resolves an aura record, or null without complete metrics and valid head/time; lifecycle getters match the probe runner.
 */
export function createWakeAuraReader({ readAuraInputs, timeoutMs, monotonicNow, setTimeout, clearTimeout } = {}) {
  if (readAuraInputs !== undefined && typeof readAuraInputs !== 'function') throw new TypeError('WAKE_AURA_READER_INVALID')
  const metrics = ['reachableDagNodes', 'declaredDagNodes', 'verifiedReceipts', 'totalReceipts',
    'activeOrgans', 'declaredOrgans', 'observedSurpriseScores', 'handOffEpochMismatch',
    'unanchoredPredictions', 'pendingWakes', 'lastRollbackAgeEpochs', 'staleHeartbeatRatio']
  const score = (head, now, inputs) => {
    if (head === null) return null
    const selected = probeData(head, ['ballId', 'epoch'])
    if (!selected) return null
    const values = {}
    if (record(inputs)) for (const key of metrics) {
      const property = Object.getOwnPropertyDescriptor(inputs, key)
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) continue
      if (key === 'observedSurpriseScores' && (!Array.isArray(property.value) || property.value.length > AURA_INPUT_LIMITS.surpriseScores)) continue
      values[key] = property.value
    }
    return auraInputsComplete(values) ? computeAura({ ...values, computedAt: now, ballId: selected.ballId, epoch: selected.epoch }) : null
  }
  let candidate = null
  const runner = createWakeProbeRunner({ timeoutMs, monotonicNow, setTimeout, clearTimeout,
    ...(readAuraInputs === undefined ? {} : { runWakeProbe: async input => {
      const values = await readAuraInputs(input)
      candidate = score(input.head, input.now, values)
      return { status: 'success' }
    } }),
  })
  return {
    get available() { return runner.available },
    get busy() { return runner.busy },
    whenSettled: () => runner.whenSettled(),
    dispose: () => runner.dispose(),
    async read({ head, now }) {
      if (head === null || !runner.available) return null
      try {
        const selected = probeData(head, ['ballId', 'epoch'])
        if (!selected || typeof selected.ballId !== 'string' || !HEX.test(selected.ballId)
          || !Number.isSafeInteger(selected.epoch) || selected.epoch < 0 || Object.is(selected.epoch, -0)
          || !Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 || Object.is(now, -0)) return null
      } catch (error) { return null }
      candidate = null
      const result = await runner.run({ head, now })
      return result.status === 'probe_succeeded' ? candidate : null
    },
  }
}

function unicode(value) {
  if (typeof value !== 'string') return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function validText(value, maxBytes, maxLength = maxBytes) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && unicode(value) && bytes(value) <= maxBytes && value.trim() !== ''
}

function validName(value) {
  return validText(value, MESSAGES_LIMITS.nameBytes, 120)
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
}

function validNpub(value) {
  // Only canonical lower-case npub bech32 is accepted, never an unlabelled hex key.
  if (typeof value !== 'string' || value.length !== 63 || value !== value.toLowerCase() || !value.startsWith('npub1')) return false
  try {
    const decoded = bech32.decodeToBytes(value)
    return decoded.prefix === 'npub' && decoded.bytes.length === 32
      && bech32.encodeFromBytes('npub', decoded.bytes) === value
  } catch (_error) {
    return false
  }
}

function validMembers(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= MESSAGES_LIMITS.members
    && value.every(validNpub) && new Set(value).size === value.length
}

function canonical(value) {
  let nodes = 0
  const visit = (item, depth) => {
    if (++nodes > 20000 || depth > 12) refuse('MESSAGES_JSON_LIMIT')
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'string' && unicode(item)) return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return JSON.stringify(item)
    if (Array.isArray(item)) return '[' + item.map(child => visit(child, depth + 1)).join(',') + ']'
    if (record(item)) return '{' + Object.keys(item).sort().map(key => {
      if (!unicode(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) refuse('MESSAGES_JSON_INVALID')
      return JSON.stringify(key) + ':' + visit(item[key], depth + 1)
    }).join(',') + '}'
    refuse('MESSAGES_JSON_INVALID')
  }
  return visit(value, 0)
}

async function shaText(value) {
  if (!globalThis.crypto?.subtle) refuse('MESSAGES_DIGEST_UNAVAILABLE', 503)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

const sha = value => shaText(canonical(value))

function identityView(state) {
  return Object.hasOwn(state, 'identity')
    ? { npub: state.identity.npub, pubkey: state.identity.pubkey, signing: 'bip340-schnorr' }
    : { npub: null, pubkey: null, signing: 'unavailable' }
}

/**
 * Read public signing metadata without initializing messages, signing, or contacting relays.
 * Existing private state is validated before projection; secrets never leave the transaction.
 * @param {object} storage Owner exposing a read-capable transaction with get.
 * @returns {Promise<object|null>} Public identity and explicitly disconnected relay, or null for unavailable/corrupt storage.
 */
export async function readMessagesStatus(storage) {
  try {
    return await storage.transaction(async tx => {
      const stored = await tx.get(MESSAGES_STORAGE_KEY)
      const state = stored === undefined ? {} : await validateState(stored)
      return { identity: identityView(state), relay: { connected: false, urls: [] } }
    })
  } catch (_error) {
    return null
  }
}

function validIdentity(identity) {
  if (!fields(identity, ['version', 'secretKey', 'pubkey', 'npub']) || identity.version !== IDENTITY_VERSION
    || typeof identity.secretKey !== 'string' || !HEX.test(identity.secretKey)
    || typeof identity.pubkey !== 'string' || !HEX.test(identity.pubkey) || !validNpub(identity.npub)) return false
  const secretKey = hexToBytes(identity.secretKey)
  try {
    const pubkey = schnorr.getPublicKey(secretKey)
    return bytesToHex(pubkey) === identity.pubkey && bech32.encodeFromBytes('npub', pubkey) === identity.npub
  } catch (_error) {
    return false
  } finally {
    secretKey.fill(0)
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) && ms >= 0 && new Date(ms).toISOString() === value
}

function timestamp(now) {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999 || Object.is(value, -0)) {
    refuse('MESSAGES_CLOCK_INVALID', 503)
  }
  return new Date(value).toISOString()
}

function localConversation(id, kind, name, createdAt, details = {}) {
  return {
    id, kind, name, npub: null, controller: null, memberNpubs: [], desiredProtocol: null,
    protocol: LOCAL, tier: LOCAL, mls: null, createdAt, ...details,
  }
}

function initialState(at) {
  return {
    version: VERSION,
    conversations: [
      localConversation('auma-pearl', 'channel', 'Auma Pearl', at),
      localConversation('marmot-preparation', 'channel', 'Marmot preparation', at, { desiredProtocol: 'marmot-mls' }),
    ],
    turns: [],
  }
}

function contactBinding(conversation) {
  return conversation.kind === 'contact'
    ? { kind: 'contact', name: conversation.name, npub: conversation.npub, controller: conversation.controller }
    : { kind: 'marmot-group', name: conversation.name, memberNpubs: conversation.memberNpubs }
}

async function contactId(binding) {
  // A contact's address is stable. A second name/controller for it is a conflict, not an overwrite.
  const identity = binding.kind === 'contact' ? { kind: binding.kind, npub: binding.npub } : binding
  return `${binding.kind === 'contact' ? 'contact' : 'group'}-${await sha(identity)}`
}

function eventBinding(turn) {
  const { id: _id, ...unsignedLocalRecord } = turn
  return { version: VERSION, ...unsignedLocalRecord }
}

function localTags(conversationId) {
  return [['d', `aukora-messages:${conversationId}`], ['conversation', conversationId], ['protocol', LOCAL]]
}

function signedTags(turn) {
  // Bind local replay metadata too; distinct requests in one second must have distinct NIP-01 IDs.
  return [...localTags(turn.conversationId), ['request', turn.requestId], ['at', turn.at]]
}

function nip01Id(turn) {
  return shaText(JSON.stringify([0, turn.pubkey, turn.created_at, turn.kind, turn.tags, turn.content]))
}

function validSignature(turn) {
  try {
    return schnorr.verify(hexToBytes(turn.sig), hexToBytes(turn.id), hexToBytes(turn.pubkey))
  } catch (_error) {
    return false
  }
}

// The node's ONE signing path: message turns and the head announcement both sign here, with the same key, and are
// checked again before anything is stored. The secret key is never returned, logged or copied out of this function.
function signEventId(event, identity) {
  const secretKey = hexToBytes(identity.secretKey)
  try {
    event.sig = bytesToHex(schnorr.sign(hexToBytes(event.id), secretKey))
  } catch (_error) {
    refuse('MESSAGES_SIGNING_UNAVAILABLE', 503)
  } finally {
    secretKey.fill(0)
  }
  if (!validSignature(event)) refuse('MESSAGES_SIGNING_UNAVAILABLE', 503)
}

async function signTurn(turn, identity) {
  signEventId(turn, identity)
  turn.signatureStatus = 'signed'
}

const NOSTR_EVENT_FIELDS = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']
const nostrTags = value => Array.isArray(value) && value.length <= 64
  && value.every(tag => Array.isArray(tag) && tag.length >= 1 && tag.length <= 8 && tag.every(item => typeof item === 'string' && unicode(item) && item.length <= 1024))
const nostrUnsigned = value => fields(value, ['pubkey', 'created_at', 'kind', 'tags', 'content'])
  && typeof value.pubkey === 'string' && HEX.test(value.pubkey) && Number.isSafeInteger(value.created_at) && value.created_at >= 0
  && Number.isSafeInteger(value.kind) && value.kind >= 0 && value.kind <= 65535 && nostrTags(value.tags)
  && typeof value.content === 'string' && unicode(value.content) && bytes(value.content) <= MESSAGES_LIMITS.contentBytes

/**
 * NOSTR: check one complete NIP-01 event: its id is sha256 of the NIP-01 serialisation, and its BIP-340 signature
 * verifies under its own pubkey. Pure; no storage, no key. Exactly the seven NIP-01 fields, nothing else.
 * @param {unknown} event Candidate signed event.
 * @returns {Promise<boolean>} Whether id and signature both check.
 */
export async function verifyNostrEvent(event) {
  try {
    if (!fields(event, NOSTR_EVENT_FIELDS) || !nostrUnsigned(Object.fromEntries(Object.entries(event).filter(([key]) => !['id', 'sig'].includes(key))))
      || typeof event.id !== 'string' || !HEX.test(event.id) || typeof event.sig !== 'string' || !SIGNATURE.test(event.sig)) return false
    return event.id === await nip01Id(event) && validSignature(event)
  } catch (_error) {
    return false
  }
}

/**
 * NOSTR: the node's PUBLIC Nostr identity read inside the caller's transaction, or null before provisioning.
 * Existing private state is validated first; the secret key never leaves this module.
 * @param {object} tx Storage transaction with get.
 * @returns {Promise<{pubkey: string, npub: string}|null>}
 */
export async function readMessagesIdentityInTransaction(tx) {
  const stored = await tx.get(MESSAGES_STORAGE_KEY)
  if (stored === undefined) return null
  const state = await validateState(stored)
  return Object.hasOwn(state, 'identity') ? { pubkey: state.identity.pubkey, npub: state.identity.npub } : null
}

/**
 * NOSTR: sign one caller-built NIP-01 event with the node key, inside the caller's transaction, through the same
 * signing path as message turns (no second key path). Refuses when no key exists or the event names another pubkey.
 * The result is re-verified before it is returned; nothing is written here.
 * @param {object} tx Storage transaction with get.
 * @param {object} unsigned Exactly {pubkey, created_at, kind, tags, content}.
 * @returns {Promise<object>} The signed event: exactly id, pubkey, created_at, kind, tags, content, sig.
 */
export async function signNodeEventInTransaction(tx, unsigned) {
  if (!nostrUnsigned(unsigned)) refuse('MESSAGES_EVENT_INVALID')
  const stored = await tx.get(MESSAGES_STORAGE_KEY)
  const state = stored === undefined ? {} : await validateState(stored)
  if (!Object.hasOwn(state, 'identity')) refuse('MESSAGES_IDENTITY_REQUIRED', 409)
  if (unsigned.pubkey !== state.identity.pubkey) refuse('MESSAGES_EVENT_PUBKEY_MISMATCH', 409)
  const event = { id: '', pubkey: unsigned.pubkey, created_at: unsigned.created_at, kind: unsigned.kind,
    tags: JSON.parse(JSON.stringify(unsigned.tags)), content: unsigned.content, sig: '' }
  event.id = await nip01Id(event)
  signEventId(event, state.identity)
  if (!await verifyNostrEvent(event)) refuse('MESSAGES_SIGNING_UNAVAILABLE', 503)
  return event
}

async function validateState(input) {
  const corrupt = () => refuse('MESSAGES_STATE_CORRUPT', 503)
  let serialized
  try { serialized = canonical(input) } catch (_error) { corrupt() }
  if (bytes(serialized) > MESSAGES_LIMITS.stateBytes) corrupt()
  // Storage adapters may return references. Work only on an owned copy, never an adapter's cached object.
  const state = JSON.parse(serialized)
  if (!fields(state, ['version', 'conversations', 'turns'], ['identity']) || state.version !== VERSION
    || !Array.isArray(state.conversations) || state.conversations.length < 2
    || state.conversations.length > MESSAGES_LIMITS.conversations
    || !Array.isArray(state.turns) || state.turns.length > MESSAGES_LIMITS.turns) corrupt()
  if (Object.hasOwn(state, 'identity') && !validIdentity(state.identity)) corrupt()
  const ids = new Set()
  for (const conversation of state.conversations) {
    if (!fields(conversation, conversationFields) || typeof conversation.id !== 'string' || !CONVERSATION_ID.test(conversation.id)
      || ids.has(conversation.id) || !validName(conversation.name) || !validDate(conversation.createdAt)
      || conversation.protocol !== LOCAL || conversation.tier !== LOCAL || conversation.mls !== null) corrupt()
    ids.add(conversation.id)
    if (conversation.kind === 'channel') {
      const expectedName = conversation.id === 'auma-pearl' ? 'Auma Pearl'
        : conversation.id === 'marmot-preparation' ? 'Marmot preparation' : null
      const desired = conversation.id === 'marmot-preparation' ? 'marmot-mls' : null
      if (conversation.name !== expectedName || conversation.npub !== null || conversation.controller !== null
        || !Array.isArray(conversation.memberNpubs) || conversation.memberNpubs.length !== 0
        || conversation.desiredProtocol !== desired) corrupt()
    } else if (conversation.kind === 'contact') {
      if (!validNpub(conversation.npub) || !(conversation.controller === null
        || (typeof conversation.controller === 'string' && HEX.test(conversation.controller)))
        || !Array.isArray(conversation.memberNpubs) || conversation.memberNpubs.length !== 0
        || conversation.desiredProtocol !== null || conversation.id !== await contactId(contactBinding(conversation))) corrupt()
    } else if (conversation.kind === 'group') {
      if (conversation.npub !== null || conversation.controller !== null || !validMembers(conversation.memberNpubs)
        || conversation.memberNpubs.some((member, index, all) => index > 0 && all[index - 1] >= member)
        || conversation.desiredProtocol !== 'marmot-mls'
        || conversation.id !== await contactId(contactBinding(conversation))) corrupt()
    } else corrupt()
  }
  if (!ids.has('auma-pearl') || !ids.has('marmot-preparation')) corrupt()
  const requestIds = new Set(), eventIds = new Set()
  for (const turn of state.turns) {
    if (!fields(turn, turnFields) || typeof turn.id !== 'string' || !HEX.test(turn.id)
      || !ids.has(turn.conversationId) || typeof turn.requestId !== 'string' || !REQUEST_ID.test(turn.requestId)
      || requestIds.has(turn.requestId) || eventIds.has(turn.id) || !validText(turn.content, MESSAGES_LIMITS.contentBytes)
      || turn.content.includes('\0') || !validDate(turn.at) || turn.delivery !== LOCAL || turn.from !== 'you'
      || turn.kind !== 30078 || !Number.isSafeInteger(turn.created_at)
      || turn.created_at !== Math.floor(Date.parse(turn.at) / 1000)
      || turn.protocol !== LOCAL) corrupt()
    if (turn.idScheme === ID_SCHEME) {
      if (turn.pubkey !== null || turn.sig !== null || turn.signatureStatus !== 'unavailable'
        || canonical(turn.tags) !== canonical(localTags(turn.conversationId))
        || turn.id !== await sha(eventBinding(turn))) corrupt()
    } else if (turn.idScheme === SIGNED_ID_SCHEME) {
      if (!Object.hasOwn(state, 'identity') || turn.pubkey !== state.identity.pubkey
        || typeof turn.sig !== 'string' || !SIGNATURE.test(turn.sig) || turn.signatureStatus !== 'signed'
        || canonical(turn.tags) !== canonical(signedTags(turn))
        || turn.id !== await nip01Id(turn) || !validSignature(turn)) corrupt()
    } else corrupt()
    requestIds.add(turn.requestId)
    eventIds.add(turn.id)
  }
  return state
}

function conversationView(conversation, turns) {
  const latest = turns.findLast(turn => turn.conversationId === conversation.id)
  return {
    ...conversation, preview: latest ? latest.content : '', updatedAt: latest ? latest.at : conversation.createdAt,
    pinned: conversation.id === 'auma-pearl', unread: false, archived: false, sample: false,
  }
}

function sendView(turn) {
  return { ok: true, event: turn, turn, delivery: LOCAL }
}

function checkStateSize(state) {
  // The value itself is JSON, not a JSON string whose escaped representation could exceed the DO ceiling.
  if (bytes(JSON.stringify(state)) > MESSAGES_LIMITS.stateBytes) refuse('MESSAGES_STATE_LIMIT', 507)
}

async function storeState(tx, state) {
  checkStateSize(state)
  await tx.put(MESSAGES_STORAGE_KEY, state)
}

/**
 * Provision one immutable signing identity in private owner storage after explicit action-time approval.
 * The cloud HEAD's `nostr_provision` action invokes this with consumeProvisionApprovalInTransaction (the owner's
 * Class 3 passkey approval of that exact request). Do not enable it in local-host storage
 * until its private key is isolated from the model's raw-shell capability; mirror exclusion is insufficient.
 * Existing state is validated without repair. Repeated calls return the same public identity without writes,
 * and without consuming an approval: only minting a NEW key needs one.
 * @param {object} storage Private owner adapter with serializable, commit-before-resolve transactions; never a mirror.
 * @param {object} options approved must equal true after owner approval; absent now uses Date.now, otherwise integer milliseconds.
 *   NOSTR: optional trusted consumeProvisionApprovalInTransaction(tx) consumes the approval inside this transaction,
 *   before any key exists; it returns the consumed approval with expiresAt, or throws. Mint and consumption commit together.
 * @returns {Promise<object>} Only npub, pubkey and signing. Refuses before accessing storage when approval is absent.
 */
export async function provisionMessagesIdentity(storage, { approved = false, now = Date.now, consumeProvisionApprovalInTransaction } = {}) {
  if (approved !== true) refuse('MESSAGES_IDENTITY_PROVISIONING_REQUIRED', 403)
  if (consumeProvisionApprovalInTransaction !== undefined && typeof consumeProvisionApprovalInTransaction !== 'function') refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
  if (!storage || typeof storage.transaction !== 'function') refuse('MESSAGES_STORAGE_UNAVAILABLE', 503)
  return storage.transaction(async tx => {
    const stored = await tx.get(MESSAGES_STORAGE_KEY)
    const state = stored === undefined ? initialState(timestamp(now)) : await validateState(stored)
    if (Object.hasOwn(state, 'identity')) return identityView(state)
    if (consumeProvisionApprovalInTransaction !== undefined) {
      const startedAt = Date.parse(timestamp(now))
      const approval = await consumeProvisionApprovalInTransaction(tx)
      const checkedAt = now()
      if (approval?.ok !== true || !Number.isSafeInteger(approval.expiresAt)
        || !Number.isSafeInteger(checkedAt) || checkedAt < startedAt || checkedAt >= approval.expiresAt) refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
    }
    let secretKey
    try {
      secretKey = schnorr.utils.randomSecretKey()
      const pubkey = schnorr.getPublicKey(secretKey)
      state.identity = { version: IDENTITY_VERSION, secretKey: bytesToHex(secretKey), pubkey: bytesToHex(pubkey),
        npub: bech32.encodeFromBytes('npub', pubkey) }
    } catch (_error) {
      refuse('MESSAGES_SIGNING_UNAVAILABLE', 503)
    } finally {
      if (secretKey) secretKey.fill(0)
    }
    await storeState(tx, state)
    return identityView(state)
  })
}

function reply(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders },
  })
}

async function requestJson(request) {
  const contentType = request.headers.get('content-type')
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    refuse('MESSAGES_JSON_REQUIRED', 415)
  }
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) refuse('MESSAGES_CONTENT_LENGTH_INVALID')
  if (length !== null && Number(length) > MESSAGES_LIMITS.requestBytes) refuse('MESSAGES_REQUEST_LIMIT', 413)
  const encoding = request.headers.get('content-encoding')
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') refuse('MESSAGES_ENCODING_UNSUPPORTED', 415)
  if (!request.body) refuse('MESSAGES_JSON_REQUIRED')
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const deadline = performance.now() + 30000
  let count = 0, text = '', expired = false, complete = false
  const cancel = () => { void reader.cancel().catch((_error) => { /* Cancellation failure cannot admit a body. */ }) }
  const timer = setTimeout(() => { expired = true; cancel() }, 30000)
  const check = () => {
    if (expired || performance.now() >= deadline) refuse('MESSAGES_REQUEST_TIMEOUT', 408)
    if (request.signal.aborted) refuse('MESSAGES_REQUEST_ABORTED', 408)
  }
  request.signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      check()
      let chunk
      try { chunk = await reader.read() } catch (_error) { check(); refuse('MESSAGES_BODY_INVALID') }
      check()
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)) refuse('MESSAGES_BODY_INVALID')
      count += chunk.value.byteLength
      if (count > MESSAGES_LIMITS.requestBytes) refuse('MESSAGES_REQUEST_LIMIT', 413)
      try { text += decoder.decode(chunk.value, { stream: true }) } catch (_error) { refuse('MESSAGES_UTF8_INVALID') }
    }
    try { text += decoder.decode() } catch (_error) { refuse('MESSAGES_UTF8_INVALID') }
    if (length !== null && Number(length) !== count) refuse('MESSAGES_CONTENT_LENGTH_MISMATCH')
    let value
    try { value = JSON.parse(text) } catch (_error) { refuse('MESSAGES_JSON_INVALID') }
    canonical(value)
    check()
    complete = true
    return value
  } finally {
    if (!complete) cancel()
    clearTimeout(timer)
    request.signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

function parseOperation(path, body, request) {
  if (path === '/aukora-messages/contacts.json') return { kind: 'list' }
  if (path === '/aukora-messages/thread') {
    if (!fields(body, ['conversationId']) || typeof body.conversationId !== 'string' || !CONVERSATION_ID.test(body.conversationId)) {
      refuse('MESSAGES_THREAD_INVALID')
    }
    return { kind: 'thread', conversationId: body.conversationId }
  }
  if (path === '/aukora-messages/send') {
    if (!fields(body, ['conversationId', 'content'], ['requestId'])
      || typeof body.conversationId !== 'string' || !CONVERSATION_ID.test(body.conversationId)
      || !validText(body.content, MESSAGES_LIMITS.contentBytes) || body.content.includes('\0')) refuse('MESSAGES_SEND_INVALID')
    const header = request.headers.get('idempotency-key')
    if (Object.hasOwn(body, 'requestId') && (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId))) {
      refuse('MESSAGES_REQUEST_ID_INVALID')
    }
    if (header !== null && !REQUEST_ID.test(header)) refuse('MESSAGES_REQUEST_ID_INVALID')
    if (header !== null && Object.hasOwn(body, 'requestId') && header !== body.requestId) refuse('MESSAGES_REQUEST_ID_CONFLICT', 409)
    const requestId = Object.hasOwn(body, 'requestId') ? body.requestId : header
    if (requestId === null) refuse('MESSAGES_REQUEST_ID_REQUIRED')
    return { kind: 'send', conversationId: body.conversationId, content: body.content, requestId }
  }
  if (!record(body) || !validName(body.name)) refuse('MESSAGES_CONTACT_INVALID')
  if (body.kind === 'contact') {
    if (!fields(body, ['kind', 'name', 'npub'], ['controller']) || !validNpub(body.npub)
      || (Object.hasOwn(body, 'controller') && (typeof body.controller !== 'string' || !HEX.test(body.controller)))) {
      refuse('MESSAGES_CONTACT_INVALID')
    }
    return { kind: 'add', binding: { kind: body.kind, name: body.name, npub: body.npub, controller: body.controller ?? null } }
  }
  if (body.kind === 'marmot-group' && fields(body, ['kind', 'name', 'memberNpubs']) && validMembers(body.memberNpubs)) {
    return { kind: 'add', binding: { kind: body.kind, name: body.name, memberNpubs: [...body.memberNpubs].sort() } }
  }
  refuse('MESSAGES_CONTACT_INVALID')
}

/**
 * Serve the four exact messages routes with a trusted adapter authorization decision.
 * Missing authorization refuses every route; no request-supplied signing, relay, or MLS claims are accepted.
 * A previously provisioned private identity signs new sends; this handler never creates or imports a key.
 * Legacy unsigned sends remain readable and replay identically after provisioning. Signatures attest only
 * to local events, not relay publication, delivery to a peer, encryption, or MLS membership.
 * The storage owner must provide serializable transactions and resolve only after commit. An adapter failure
 * reports an error, not rollback; retries of the same send requestId recover an already committed result.
 * Cloud adapters supply consumeSendApprovalInTransaction, which must consume the exact parsed request's
 * approval using this transaction, not a separate transaction. It runs after deterministic preflight for
 * new sends and replays. Absent this callback, standalone/local authorization is unchanged. Approval and
 * message writes commit together; callback failures must abort all writes. Cloud retries require fresh approval
 * if the original transaction committed. A returned deadline is checked before signing and after persistence.
 * @param {Request} request Web request, with at most 16 KiB of UTF-8 JSON on POST.
 * @param {object} storage Owner exposing transaction(async tx => ...), whose tx supports only get and put here.
 * @param {object} options authorized must equal true; now returns integer milliseconds. Optional trusted consumeSendApprovalInTransaction(tx, body) returns the consumed approval with expiresAt, or throws.
 * @returns {Promise<Response>} JSON response. Corrupt existing state returns 503 without resetting or writing it.
 */
export async function handleMessagesRequest(request, storage, { authorized = false, now = Date.now, consumeSendApprovalInTransaction } = {}) {
  try {
    if (authorized !== true) refuse('MESSAGES_AUTH_REQUIRED', 401)
    const url = new URL(request.url)
    const method = ROUTES.get(url.pathname)
    if (!method) refuse('MESSAGES_ROUTE_NOT_FOUND', 404)
    if (url.search !== '' || url.hash !== '' || request.url.includes('?')) refuse('MESSAGES_QUERY_UNSUPPORTED')
    if (request.method !== method) return reply({ ok: false, code: 'MESSAGES_METHOD_NOT_ALLOWED', error: 'MESSAGES_METHOD_NOT_ALLOWED' }, 405, { allow: method })
    if (method === 'GET' && (request.body !== null || (request.headers.has('content-length') && request.headers.get('content-length') !== '0'))) {
      refuse('MESSAGES_BODY_UNEXPECTED')
    }
    const body = method === 'POST' ? await requestJson(request) : null
    const operation = parseOperation(url.pathname, body, request)
    if (!storage || typeof storage.transaction !== 'function') refuse('MESSAGES_STORAGE_UNAVAILABLE', 503)
    const checkApproval = (approval, startedAt) => {
      const checkedAt = now()
      if (approval?.ok !== true || !Number.isSafeInteger(approval.expiresAt)
        || !Number.isSafeInteger(checkedAt) || checkedAt < startedAt || checkedAt >= approval.expiresAt) {
        refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
      }
    }
    const consumeApproval = async tx => {
      if (consumeSendApprovalInTransaction === undefined) return null
      if (typeof consumeSendApprovalInTransaction !== 'function') refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
      const startedAt = Date.parse(timestamp(now))
      const approval = await consumeSendApprovalInTransaction(tx, body)
      checkApproval(approval, startedAt)
      return { approval, startedAt }
    }
    const result = await storage.transaction(async tx => {
      const stored = await tx.get(MESSAGES_STORAGE_KEY)
      const fresh = stored === undefined
      const state = fresh ? initialState(timestamp(now)) : await validateState(stored)
      if (operation.kind === 'list') {
        if (fresh) await storeState(tx, state)
        const conversations = state.conversations.map(conversation => conversationView(conversation, state.turns))
        return { ok: true, conversations, contacts: conversations.filter(conversation => conversation.kind === 'contact'),
          identity: identityView(state), relay: { connected: false, urls: [] } }
      }
      if (operation.kind === 'add') {
        const id = await contactId(operation.binding)
        const existing = state.conversations.find(conversation => conversation.id === id)
        if (existing) {
          if (canonical(contactBinding(existing)) !== canonical(operation.binding)) refuse('MESSAGES_CONTACT_CONFLICT', 409)
          return { ok: true, conversation: conversationView(existing, state.turns) }
        }
        if (state.conversations.length >= MESSAGES_LIMITS.conversations) refuse('MESSAGES_CONVERSATION_LIMIT', 507)
        const binding = operation.binding
        const conversation = binding.kind === 'contact'
          ? localConversation(id, 'contact', binding.name, timestamp(now), { npub: binding.npub, controller: binding.controller })
          : localConversation(id, 'group', binding.name, timestamp(now), { memberNpubs: binding.memberNpubs, desiredProtocol: 'marmot-mls' })
        state.conversations.push(conversation)
        await storeState(tx, state)
        return { ok: true, conversation: conversationView(conversation, state.turns) }
      }
      if (operation.kind === 'send') {
        const previous = state.turns.find(turn => turn.requestId === operation.requestId)
        if (previous) {
          if (previous.conversationId !== operation.conversationId || previous.content !== operation.content) refuse('MESSAGES_REQUEST_ID_CONFLICT', 409)
          await consumeApproval(tx)
          return sendView(previous)
        }
      }
      if (!state.conversations.some(conversation => conversation.id === operation.conversationId)) refuse('MESSAGES_CONVERSATION_NOT_FOUND', 404)
      if (operation.kind === 'thread') {
        if (fresh) await storeState(tx, state)
        return { ok: true, turns: state.turns.filter(turn => turn.conversationId === operation.conversationId) }
      }
      if (state.turns.length >= MESSAGES_LIMITS.turns) refuse('MESSAGES_TURN_LIMIT', 507)
      const at = timestamp(now)
      const turn = {
        id: '', idScheme: ID_SCHEME, conversationId: operation.conversationId, requestId: operation.requestId, content: operation.content,
        at, created_at: Math.floor(Date.parse(at) / 1000), kind: 30078, tags: localTags(operation.conversationId),
        pubkey: null, sig: null, signatureStatus: 'unavailable', delivery: LOCAL, from: 'you', protocol: LOCAL,
      }
      const signed = Object.hasOwn(state, 'identity')
      if (signed) {
        turn.idScheme = SIGNED_ID_SCHEME
        turn.pubkey = state.identity.pubkey
        turn.tags = signedTags(turn)
        turn.id = await nip01Id(turn)
      } else {
        // This legacy digest binds an unsigned local record, not a NIP-01 event.
        turn.id = await sha(eventBinding(turn))
      }
      // BIP340 signatures always occupy 128 hex bytes. Check exact final size without signing.
      const projectedTurn = signed ? { ...turn, sig: '0'.repeat(128), signatureStatus: 'signed' } : turn
      checkStateSize({ ...state, turns: [...state.turns, projectedTurn] })
      const consumed = await consumeApproval(tx)
      if (signed) await signTurn(turn, state.identity)
      state.turns.push(turn)
      await storeState(tx, state)
      if (consumed !== null) checkApproval(consumed.approval, consumed.startedAt)
      return sendView(turn)
    })
    return reply(result)
  } catch (error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code) ? error.code : 'MESSAGES_STORAGE_UNAVAILABLE'
    return reply({ ok: false, code, error: code }, status)
  }
}

/**
 * Build an explicit absent, unreadable, or malformed prediction result for storage adapters.
 * @param {string} code Fixed diagnostic code chosen by the caller, without source content.
 * @param {string} status Defaults to unavailable; adapters can distinguish absent and malformed.
 * @returns {object} Failed projection with no claimed prediction, observation, verification, or score.
 */
export function predictionUnavailable(code, status = 'unavailable') {
  return { ok: false, status, code, error: code, verified: false, surpriseScore: null,
    latest: { register: null, observe: null }, prediction: null, observation: null }
}

function predictionData(value) {
  const primitiveNumber = item => typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)
  const count = item => Number.isSafeInteger(item) && item >= 0 && !Object.is(item, -0)
  const hash = item => typeof item === 'string' && HEX.test(item)
  const allowed = {
    predictionId: item => validText(item, 200), metric: item => validText(item, 80),
    expected: primitiveNumber, observed: primitiveNumber,
    targetBallId: hash, targetEpoch: count,
  }
  const result = {}
  for (const [key, validate] of Object.entries(allowed)) {
    if (!Object.hasOwn(value, key)) continue
    if (!validate(value[key])) refuse('PREDICTION_RECEIPT_INVALID')
    result[key] = value[key]
  }
  return result
}

/**
 * Project the last register and observe rows from the caller's fixed receipt JSONL source, in file order.
 * This parses data only: it verifies neither receipt chain nor prediction bindings, and computes no surprise score.
 * Empty/missing kinds, malformed JSON, non-finite fields, and exceeded limits return explicit failures.
 * @param {string} text Complete UTF-8 text from the specified receipt source; this function performs no I/O or mutation.
 * @returns {object} Sanitized, explicitly unverified receipt data or a failed projection with null data.
 */
export function projectPredictionReceipts(text) {
  if (typeof text !== 'string') return predictionUnavailable('PREDICTION_RECEIPTS_UNAVAILABLE')
  if (text.length > PREDICTION_LIMITS.bytes || bytes(text) > PREDICTION_LIMITS.bytes) return predictionUnavailable('PREDICTION_RECEIPTS_LIMIT')
  if (!unicode(text)) return predictionUnavailable('PREDICTION_RECEIPTS_UTF8_INVALID', 'malformed')
  if (text.trim() === '') return predictionUnavailable('PREDICTION_RECEIPTS_ABSENT', 'absent')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length > PREDICTION_LIMITS.rows) return predictionUnavailable('PREDICTION_RECEIPTS_ROW_LIMIT')
  const latest = { register: null, observe: null }
  for (const line of lines) {
    if (bytes(line) > PREDICTION_LIMITS.lineBytes) return predictionUnavailable('PREDICTION_RECEIPTS_LINE_LIMIT')
    if (line.trim() === '') continue
    let receipt
    try { receipt = JSON.parse(line) } catch (_error) { return predictionUnavailable('PREDICTION_RECEIPTS_MALFORMED', 'malformed') }
    if (!record(receipt) || !validText(receipt.kind, 200) || !record(receipt.data)) {
      return predictionUnavailable('PREDICTION_RECEIPTS_MALFORMED', 'malformed')
    }
    if (receipt.kind !== 'prediction.register' && receipt.kind !== 'prediction.observe') continue
    let data
    try { data = predictionData(receipt.data) } catch (error) { return predictionUnavailable(error.code, 'malformed') }
    const projected = { kind: receipt.kind, data, verified: false, surpriseScore: null }
    if (Object.hasOwn(receipt, 'seq')) {
      if (!Number.isSafeInteger(receipt.seq) || receipt.seq < 0 || Object.is(receipt.seq, -0)) return predictionUnavailable('PREDICTION_RECEIPTS_MALFORMED', 'malformed')
      projected.seq = receipt.seq
    }
    if (Object.hasOwn(receipt, 'at')) {
      if (!validText(receipt.at, 128)) return predictionUnavailable('PREDICTION_RECEIPTS_MALFORMED', 'malformed')
      projected.at = receipt.at
    }
    latest[receipt.kind === 'prediction.register' ? 'register' : 'observe'] = projected
  }
  if (latest.register === null && latest.observe === null) return predictionUnavailable('PREDICTION_RECEIPTS_ABSENT', 'absent')
  return { ok: true, status: 'unverified', verified: false, surpriseScore: null, latest,
    prediction: latest.register === null ? null : latest.register.data,
    observation: latest.observe === null ? null : latest.observe.data }
}
