// THE ONLY MODULE THAT IMPORTS THE VOICE PROVIDER'S SDK.
// Bundled by build-auma-live-modules.mjs to apps/web/public/app/managed-voice.js, with the SDK pinned at exactly 1.36.0
// and its capture worklet byte-copied beside it as /app/eleven-raw-audio.js. aumalive.js loads this file only when the
// orb is pressed, and binds her governed side (genesis-live.js, self-index.js) into it; nothing here holds its own copy.
import { Conversation } from '@elevenlabs/client'
import { createManagedConversation } from './controller.mjs'

export { correctionMatches, createArrivalRunner, createGovernedTurnRunner, markCut } from './governed-turn.mjs'
export { MANAGED_VOICE } from './policy.mjs'

/** One managed voice for this page: same-origin edge requests, the same-origin tab door, the SDK's WebRTC call. */
export function createManagedVoice(options) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return createManagedConversation({
    ...options,
    startSession: config => Conversation.startSession(config),
    request: (path, init) => fetch(path, init),
    openBridge: path => new WebSocket(`${scheme}//${location.host}${path}`),
  })
}
