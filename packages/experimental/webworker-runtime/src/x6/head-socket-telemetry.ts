/**
 * Aukora X6.1 Lane E3: the worker's own `/_head/ws` socket facts, reported on `GET /__x6__/status` as `headSocket`.
 *
 * Playwright 1.61.1 reports a dedicated worker's WebSocket without any of its frames in Chromium, Firefox and WebKit,
 * so the fresh-window observer cannot prove her socket open from the page. The runtime counts its own lifecycle
 * instead. The tracker lives in the build-pinned T2 worker image (ball-loader.ts), not in T1 VFS, so an organ cannot
 * write these counters; it only ever sees the closure-held socket through the presence service, whose sends are real
 * frames and are counted as such.
 *
 * Honesty rule (the same as deploy/ci/observe-fresh-x61.mjs headSocketState): `state` is 'open' only when the ACTIVE
 * socket reports `readyState === 1`, has not closed, and has carried at least one frame on that same socket (HEAD greets
 * every accepted socket with `ball:commit`; `onopen` sends `presence:hello`). A socket with no frame yet is 'connecting',
 * a closed or closing one 'closed'; with no usable origin or no `WebSocket`, or before any socket exists, 'absent'.
 * Frame counters are per active socket and reset on reconnect, so a dead socket's history never vouches for a new one;
 * totals are reported separately. Every counter saturates at Number.MAX_SAFE_INTEGER.
 */

/** The `readyState` value of an open WebSocket (a literal, so fakes and polyfills compare the same way). */
const OPEN = 1

/** The facts `readStatus().headSocket` carries. */
export interface HeadSocketTelemetry {
  readonly state: 'open' | 'connecting' | 'closed' | 'absent'
  /** Frames received on the active socket. */
  readonly framesReceived: number
  /** Frames sent on the active socket (counted after the browser accepted the send). */
  readonly framesSent: number
  /** Error events across every socket this runtime opened, plus constructor failures. */
  readonly errors: number
  /** Sockets opened after the first one. */
  readonly reconnects: number
  /** The active socket's readyState at the time of the read, or null when there is none. */
  readonly readyState: number | null
  readonly totalFramesReceived: number
  readonly totalFramesSent: number
  /** Close code of the active socket once it closed, else null. */
  readonly lastCloseCode: number | null
}

/** The part of a WebSocket the tracker touches. */
export interface TrackedSocket {
  readonly readyState: number
  send(data: string): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { code?: number }) => void): void
}

const bump = (value: number): number => (value < Number.MAX_SAFE_INTEGER ? value + 1 : value)

/** One runtime's head-socket tracker. */
export interface HeadSocketTracker {
  /** Record that this runtime can open head sockets at all (an origin and `WebSocket` exist). */
  markAvailable(): void
  /** Adopt a newly constructed socket as the active one; wraps its `send` so accepted sends are counted. */
  attach(socket: TrackedSocket): void
  /** Count a socket constructor failure. */
  noteError(): void
  /** The current facts. */
  snapshot(): HeadSocketTelemetry
}

/**
 * Create a tracker.
 * @returns A tracker whose snapshot starts 'absent'.
 */
export function createHeadSocketTracker(): HeadSocketTracker {
  let available = false
  let active: TrackedSocket | undefined
  let activeClosed = false
  let attached = 0
  let framesReceived = 0, framesSent = 0, totalReceived = 0, totalSent = 0, errors = 0
  let lastCloseCode: number | null = null
  return {
    markAvailable() { available = true },
    noteError() { errors = bump(errors) },
    attach(socket) {
      attached = bump(attached)
      active = socket
      activeClosed = false
      framesReceived = 0
      framesSent = 0
      lastCloseCode = null
      const nativeSend = socket.send.bind(socket)
      // Counted only after the browser accepted the frame: send() throws before open.
      socket.send = (data: string): void => {
        nativeSend(data)
        if (active === socket) framesSent = bump(framesSent)
        totalSent = bump(totalSent)
      }
      socket.addEventListener('message', () => {
        if (active === socket) framesReceived = bump(framesReceived)
        totalReceived = bump(totalReceived)
      })
      socket.addEventListener('error', () => { errors = bump(errors) })
      socket.addEventListener('close', (event) => {
        if (active !== socket) return
        activeClosed = true
        lastCloseCode = typeof event?.code === 'number' ? event.code : null
      })
    },
    snapshot() {
      const readyState = active === undefined ? null : Number(active.readyState)
      const frames = framesReceived + framesSent
      const state: HeadSocketTelemetry['state'] = !available || active === undefined ? 'absent'
        : !activeClosed && readyState === OPEN && frames > 0 ? 'open'
          : !activeClosed && (readyState === 0 || readyState === OPEN) ? 'connecting'
            : 'closed'
      return { state, framesReceived, framesSent, errors, reconnects: Math.max(0, attached - 1), readyState,
        totalFramesReceived: totalReceived, totalFramesSent: totalSent, lastCloseCode }
    },
  }
}
