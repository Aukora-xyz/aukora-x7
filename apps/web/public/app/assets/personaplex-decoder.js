importScripts('/app/assets/decoderWorker.min.js')

const handleMessage = self.onmessage
self.onmessage = event => {
  handleMessage(event)
  if (event.data?.command === 'init') {
    Module.mainReady.then(() => self.postMessage({ type: 'ready' }))
  }
}
