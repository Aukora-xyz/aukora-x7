const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export function personaPlexEndpoint(value) {
  const url = new URL(String(value || '').trim())
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use a WebSocket URL without embedded credentials.')
  if (url.protocol === 'ws:' && !LOOPBACK.has(url.hostname)) throw new Error('An unencrypted PersonaPlex connection is allowed only on this computer.')
  if (url.pathname !== '/api/chat') throw new Error('The PersonaPlex server endpoint must end in /api/chat.')
  for (const key of url.searchParams.keys()) {
    if (!['text_prompt', 'voice_prompt', 'seed'].includes(key)) throw new Error(`Unsupported PersonaPlex query setting: ${key}`)
  }
  return url.href
}

export function probePersonaPlex(value, { timeoutMs = 5000 } = {}) {
  const endpoint = personaPlexEndpoint(value)
  return new Promise(resolve => {
    let settled = false
    let socket
    const finish = (connected, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
        if (socket.readyState === 0 || socket.readyState === 1) socket.close(1000, 'probe complete')
      }
      resolve({ connected, detail })
    }
    const timer = setTimeout(() => finish(false, 'NOT CONNECTED YET · no PersonaPlex handshake within five seconds.'), timeoutMs)
    try {
      socket = new WebSocket(endpoint)
      socket.binaryType = 'arraybuffer'
      socket.onmessage = event => {
        const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null
        if (bytes?.length === 1 && bytes[0] === 0) finish(true, 'PersonaPlex handshake verified · no microphone audio sent. Audio transport NOT CONNECTED YET.')
        else finish(false, 'NOT CONNECTED YET · the endpoint did not return the PersonaPlex handshake.')
      }
      socket.onerror = () => finish(false, 'NOT CONNECTED YET · the local PersonaPlex server did not answer.')
      socket.onclose = () => finish(false, 'NOT CONNECTED YET · the PersonaPlex server closed before its handshake.')
    } catch {
      finish(false, 'NOT CONNECTED YET · the PersonaPlex connection could not be opened.')
    }
  })
}
