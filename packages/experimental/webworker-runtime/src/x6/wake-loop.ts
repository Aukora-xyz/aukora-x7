/**
 * Lane E4: the open-tab autonomous wake loop. HEAD broadcasts `wake:updated` (and the peripheral `wake.changed` hint)
 * on `/_head/ws`. When a scheduled (alarm) wake fires and no turn is running in this tab, the loop does exactly two
 * things, once per wakeId: POST `/_host/wake` `{ action: 'acknowledge', wakeId }` and run one bounded check/wish step.
 * It never loops: a wakeId is handled at most once, at most one step runs at a time, and the step cannot schedule a wake.
 * An acknowledge the host does not support yet (the server side lands in parallel) degrades to a typed status.
 * Lane E5 foreground guard: while a foreground turn is running (a tool executing or a registered transcript turn), the
 * host wake is still acknowledged, so HEAD's unacknowledged counter never auto-pauses her for being busy, but the
 * background step and its journal write are skipped (`acknowledged-step-skipped`), and the probe is checked again after
 * the acknowledge returns.
 * @module x6/wake-loop
 */
import { createTransitionContext, type TransitionContext } from './transition-context.ts'

const WAKE_ID = /^wake-[A-Za-z0-9._:-]{1,160}$/
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export type WakeAckStatus = 'acknowledged' | 'unsupported' | 'unauthorized' | 'refused' | 'unavailable' | 'unreachable'

export interface WakeAckResult {
  readonly status: WakeAckStatus
  readonly httpStatus: number | null
  readonly code: string | null
}

export type WakeFrameOutcome =
  | { readonly outcome: 'handled'; readonly wakeId: string; readonly ack: WakeAckResult; readonly step: Record<string, unknown>; readonly operationId: string }
  | {
    readonly outcome: 'acknowledged-step-skipped'
    readonly wakeId: string
    readonly ack: WakeAckResult
    readonly reason: 'FOREGROUND_TURN_RUNNING'
    readonly operationId: string
  }
  | { readonly outcome: 'duplicate' | 'busy' | 'ignored-manual' | 'ignored-idempotent' | 'ignored-no-receipt'; readonly wakeId: string | null }
  | { readonly outcome: 'hint-only'; readonly wakeId: null }
  | { readonly outcome: 'invalid'; readonly wakeId: null; readonly code: string }

export interface WakeLoopDeps {
  /** POST `/_host/wake` `{ action: 'acknowledge', wakeId }` with same-origin credentials. Throws only on network failure. */
  acknowledge(wakeId: string, context: TransitionContext): Promise<{ status: number; json: unknown }>
  /** One bounded autonomous check/wish step. Must honour `signal`. */
  step(input: {
    wakeId: string
    receipt: Record<string, unknown>
    signal: AbortSignal
    context: TransitionContext
  }): Promise<Record<string, unknown>>
  /** Whether a foreground turn (a tool execution or a registered transcript turn) is running in this tab now. */
  isTurnRunning(): boolean
  /** Step deadline; default 15 s. */
  readonly stepTimeoutMs?: number
  /** How many handled wakeIds are remembered; default 256. */
  readonly maxTracked?: number
}

/** Map an acknowledge answer to a typed status; nothing here throws. */
export function classifyWakeAck(httpStatus: number | null, json: unknown): WakeAckResult {
  const code = record(json) && typeof json.code === 'string' ? json.code.slice(0, 80) : null
  if (httpStatus === null) return { status: 'unreachable', httpStatus, code }
  if (httpStatus >= 200 && httpStatus < 300) {
    return record(json) && json.ok === true ? { status: 'acknowledged', httpStatus, code } : { status: 'refused', httpStatus, code: code ?? 'WAKE_ACK_NOT_CONFIRMED' }
  }
  if (httpStatus === 401 || httpStatus === 403) return { status: 'unauthorized', httpStatus, code }
  // A host without the acknowledge action answers 404/405/501, or 400 WAKE_REQUEST_INVALID from the older validator.
  if (httpStatus === 404 || httpStatus === 405 || httpStatus === 501 || (httpStatus === 400 && (code === null || code === 'WAKE_REQUEST_INVALID'))) {
    return { status: 'unsupported', httpStatus, code }
  }
  if (httpStatus >= 400 && httpStatus < 500) return { status: 'refused', httpStatus, code }
  return { status: 'unavailable', httpStatus, code }
}

/**
 * Create the loop. Feed it every parsed `/_head/ws` frame; non-wake frames return null.
 * @param deps - acknowledge transport, the bounded step and the turn probe.
 * @returns `onFrame` and a bounded `snapshot` for `/__x6__/status`.
 */
export function createWakeLoop(deps: WakeLoopDeps): {
  onFrame(frame: unknown): Promise<WakeFrameOutcome | null>
  snapshot(): Record<string, unknown>
} {
  const maxTracked = Math.min(Math.max(deps.maxTracked ?? 256, 8), 4096)
  const stepTimeoutMs = Math.min(Math.max(deps.stepTimeoutMs ?? 15_000, 100), 60_000)
  const handled = new Set<string>()
  const recent: WakeFrameOutcome[] = []
  let inFlight: string | null = null
  let lastHintAt: number | null = null
  let handledTotal = 0
  let skippedForForeground = 0
  const remember = (outcome: WakeFrameOutcome): WakeFrameOutcome => {
    recent.push(outcome)
    if (recent.length > 8) recent.shift()
    return outcome
  }
  const markHandled = (wakeId: string): void => {
    handled.add(wakeId)
    if (handled.size > maxTracked) handled.delete(handled.values().next().value as string)
  }
  const onFrame = async (frame: unknown): Promise<WakeFrameOutcome | null> => {
    if (!record(frame)) return null
    if (frame.type === 'wake.changed') { lastHintAt = Date.now(); return remember({ outcome: 'hint-only', wakeId: null }) }
    if (frame.type !== 'wake:updated') return null
    if (!record(frame.wake)) return remember({ outcome: 'invalid', wakeId: null, code: 'WAKE_FRAME_INVALID' })
    const receipt = frame.wake.receipt
    if (!record(receipt)) return remember({ outcome: 'ignored-no-receipt', wakeId: null })
    const wakeId = receipt.wakeId
    if (typeof wakeId !== 'string' || !WAKE_ID.test(wakeId)) return remember({ outcome: 'invalid', wakeId: null, code: 'WAKE_ID_INVALID' })
    if (frame.wake.idempotent === true) return remember({ outcome: 'ignored-idempotent', wakeId })
    if (receipt.trigger !== 'alarm') return remember({ outcome: 'ignored-manual', wakeId })
    if (handled.has(wakeId)) return remember({ outcome: 'duplicate', wakeId })
    if (inFlight !== null) { markHandled(wakeId); return remember({ outcome: 'busy', wakeId }) }
    markHandled(wakeId)
    inFlight = wakeId
    try {
      const ackContext = createTransitionContext('wake.acknowledge')
      let ack: WakeAckResult
      try {
        const answer = await deps.acknowledge(wakeId, ackContext)
        ack = classifyWakeAck(answer.status, answer.json)
      } catch (_error) { ack = classifyWakeAck(null, null) }
      // Foreground guard: acknowledged either way; the background side effect never competes with a running turn.
      if (deps.isTurnRunning()) {
        skippedForForeground += 1
        return remember({ outcome: 'acknowledged-step-skipped', wakeId, ack, reason: 'FOREGROUND_TURN_RUNNING', operationId: ackContext.operationId })
      }
      const stepContext = createTransitionContext('wake.step', ackContext.operationId)
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, stepTimeoutMs)
      let step: Record<string, unknown>
      try {
        step = await Promise.race([
          deps.step({ wakeId, receipt: { ...receipt }, signal: controller.signal, context: stepContext }),
          new Promise<Record<string, unknown>>((resolve) => {
            controller.signal.addEventListener('abort', () => { resolve({ ok: false, code: 'WAKE_STEP_TIMEOUT', timeoutMs: stepTimeoutMs }) }, { once: true })
          }),
        ])
      } catch (error) {
        step = { ok: false, code: 'WAKE_STEP_FAILED', error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }
      } finally { clearTimeout(timer) }
      handledTotal += 1
      return remember({ outcome: 'handled', wakeId, ack, step, operationId: ackContext.operationId })
    } finally { inFlight = null }
  }
  return {
    onFrame,
    snapshot: () => ({
      handledTotal,
      tracked: handled.size,
      inFlight,
      lastHintAt,
      skippedForForeground,
      recent: recent.map(item => item.outcome === 'handled'
        ? { outcome: item.outcome, wakeId: item.wakeId, ack: item.ack, stepOk: item.step.ok === true, operationId: item.operationId }
        : item),
    }),
  }
}
