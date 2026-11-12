/** Metadata-only host activity and non-forcing shutdown coordination. */
export function createHostLifecycle({ canDrain, stop, onError = () => {} }) {
  const startedAt = Date.now()
  let phase = 'running'
  let requestedAt = null
  let blocker = null
  let httpRequests = 0
  let websocketOperations = 0
  let revision = 0
  let timer = null
  let checking = false

  const status = () => ({
    version: 1, pid: process.pid, startedAt, phase, requestedAt, blocker,
    activeHttpRequests: httpRequests, activeWebSocketOperations: websocketOperations,
  })
  const accepting = () => phase === 'running' || phase === 'waiting'
  const schedule = () => {
    if (phase !== 'waiting' || checking || timer) return
    timer = setTimeout(() => { timer = null; void check() }, 250)
    timer.unref()
  }
  const check = async () => {
    if (phase !== 'waiting' || checking) return
    if (httpRequests || websocketOperations) {
      blocker = 'HOST_OPERATIONS_ACTIVE'
      schedule()
      return
    }
    checking = true
    const observedRevision = revision
    try {
      const reason = await canDrain()
      if (phase !== 'waiting') return
      if (revision !== observedRevision || httpRequests || websocketOperations) {
        blocker = 'HOST_ACTIVITY_CHANGED'
        return
      }
      if (reason) { blocker = reason; return }
      // No admitted operation can start after this synchronous transition.
      phase = 'stopping'
      blocker = null
      await stop()
      phase = 'stopped'
    } catch (error) {
      if (phase === 'stopping') phase = 'failed'
      blocker = phase === 'failed' ? 'HOST_STOP_FAILED' : 'HOST_READINESS_UNAVAILABLE'
      onError(blocker)
    } finally {
      checking = false
      schedule()
    }
  }
  return {
    accepting,
    status,
    requestDrain() {
      if (phase === 'running') { phase = 'waiting'; requestedAt = Date.now(); blocker = null }
      schedule()
      return status()
    },
    cancelDrain() {
      if (phase !== 'waiting') return { ok: false, code: 'HOST_DRAIN_NOT_CANCELLABLE', ...status() }
      phase = 'running'; requestedAt = null; blocker = null
      if (timer) { clearTimeout(timer); timer = null }
      return { ok: true, ...status() }
    },
    /** Count handler work after response close, and response streaming after handler settlement. */
    trackHttp(response, observation = false) {
      if (!accepting()) return null
      if (observation) return () => {}
      httpRequests += 1
      revision += 1
      let handlerSettled = false
      let responseSettled = response.writableFinished || response.destroyed
      let released = false
      const release = () => {
        if (released || !handlerSettled || !responseSettled) return
        released = true
        response.off('finish', responseDone)
        response.off('close', responseDone)
        httpRequests -= 1
        schedule()
      }
      const responseDone = () => { responseSettled = true; release() }
      response.once('finish', responseDone)
      response.once('close', responseDone)
      return () => { handlerSettled = true; release() }
    },
    /** Pending WebSocket handlers count; idle presence connections do not block shutdown. */
    beginWebSocketOperation() {
      if (!accepting()) return null
      websocketOperations += 1
      revision += 1
      let settled = false
      return () => {
        if (settled) return
        settled = true
        websocketOperations -= 1
        schedule()
      }
    },
  }
}
