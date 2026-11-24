// apps/web/scripts/stock-apps/opus-recorder-absent.mjs
var OpusRecorderAbsent = class {
  constructor() {
    throw new Error("PersonaPlex voice is not available on x6.1: opus-recorder is not bundled and no PersonaPlex server runs");
  }
};

// apps/web/scripts/stock-apps/personaplex-audio.js
function openSocket(endpoint, WebSocketImpl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocketImpl(endpoint);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => finish(new Error("PersonaPlex handshake timed out")), timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      if (error) {
        socket.close();
        reject(error);
      } else resolve(socket);
    };
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer && new Uint8Array(event.data)[0] === 0) finish();
    };
    socket.onerror = () => finish(new Error("PersonaPlex server connection failed"));
    socket.onclose = () => finish(new Error("PersonaPlex closed before its handshake"));
  });
}
function initPersonaPlexDecoder(WorkerImpl = globalThis.Worker, sampleRate = 48e3) {
  return new Promise((resolve, reject) => {
    const worker = new WorkerImpl("/app/assets/personaplex-decoder.js");
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("PersonaPlex decoder initialization timed out"));
    }, 1e4);
    worker.onmessage = (event) => {
      if (event.data?.type !== "ready") return;
      clearTimeout(timer);
      resolve(worker);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "PersonaPlex decoder initialization failed"));
    };
    worker.postMessage({
      command: "init",
      bufferLength: 960 * sampleRate / 24e3,
      decoderSampleRate: 24e3,
      outputBufferSampleRate: sampleRate,
      resampleQuality: 0
    });
  });
}
function createPersonaPlexAudio({
  endpoint,
  onText,
  onMic,
  onHer,
  onState,
  WebSocketImpl = globalThis.WebSocket,
  WorkerImpl = globalThis.Worker,
  RecorderImpl = OpusRecorderAbsent,
  AudioContextImpl = globalThis.AudioContext,
  AudioWorkletNodeImpl = globalThis.AudioWorkletNode,
  mediaDevices = globalThis.navigator?.mediaDevices,
  handshakeTimeoutMs = 3e4
}) {
  let socket = null;
  let context = null;
  let worklet = null;
  let decoder = null;
  let recorder = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let meterFrame = 0;
  let stopped = false;
  let running = false;
  const state = (value) => onState?.(value);
  const meter = () => {
    if (stopped || !analyser) return;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    onMic?.(Math.min(1, Math.sqrt(energy / samples.length) * 4));
    meterFrame = requestAnimationFrame(meter);
  };
  async function start() {
    if (running || stopped) throw new Error("PersonaPlex audio cannot be restarted");
    state("connecting");
    context = new AudioContextImpl();
    await context.resume();
    socket = await openSocket(endpoint, WebSocketImpl, handshakeTimeoutMs);
    if (stopped) {
      socket.close();
      return;
    }
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      const kind = bytes[0];
      if (kind === 1) decoder.postMessage({ command: "decode", pages: bytes.slice(1) }, [bytes.slice(1).buffer]);
      else if (kind === 2) onText?.(new TextDecoder().decode(bytes.slice(1)));
      else if (kind === 5) state("error");
    };
    socket.onclose = () => {
      running = false;
      if (!stopped) state("disconnected");
    };
    socket.onerror = () => {
      if (!stopped) state("error");
    };
    const sampleRate = context.sampleRate;
    const decoderPromise = initPersonaPlexDecoder(WorkerImpl, sampleRate);
    await context.audioWorklet.addModule("/app/personaplex-player.js");
    worklet = new AudioWorkletNodeImpl(context, "moshi-processor", { outputChannelCount: [1] });
    worklet.connect(context.destination);
    decoder = await decoderPromise;
    decoder.onmessage = (event) => {
      const frame = event.data?.[0];
      if (!(frame instanceof Float32Array)) return;
      let energy = 0;
      for (const sample of frame) energy += sample * sample;
      onHer?.(Math.min(1, Math.sqrt(energy / Math.max(1, frame.length)) * 4));
      worklet.port.postMessage({
        type: "audio",
        frame,
        micDuration: (recorder?.encodedSamplePosition ?? 0) / 48e3
      }, [frame.buffer]);
    };
    decoder.onerror = () => {
      if (!stopped) state("error");
    };
    if (!mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable");
    stream = await mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    if (stopped) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    recorder = new RecorderImpl({
      sourceNode: source,
      encoderPath: "/app/assets/encoderWorker.min.js",
      bufferLength: Math.round(960 * sampleRate / 24e3),
      encoderFrameSize: 20,
      encoderSampleRate: 24e3,
      maxFramesPerPage: 2,
      numberOfChannels: 1,
      recordingGain: 1,
      resampleQuality: 3,
      encoderComplexity: 0,
      encoderApplication: 2049,
      streamPages: true
    });
    recorder.ondataavailable = (page) => {
      if (stopped || socket.readyState !== 1) return;
      const packet = new Uint8Array(page.length + 1);
      packet[0] = 1;
      packet.set(page, 1);
      socket.send(packet);
    };
    await recorder.start();
    if (stopped) return;
    running = true;
    meter();
    state("connected");
  }
  async function stop() {
    if (stopped) return;
    stopped = true;
    running = false;
    cancelAnimationFrame(meterFrame);
    if (recorder) {
      try {
        await recorder.stop();
      } catch {
        try {
          await recorder.close();
        } catch {
        }
      }
    }
    source?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    if (socket) {
      socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    decoder?.terminate();
    worklet?.disconnect();
    if (context && context.state !== "closed") await context.close();
    state("disconnected");
  }
  return { start, stop, get running() {
    return running;
  } };
}
export {
  OpusRecorderAbsent as Recorder,
  createPersonaPlexAudio,
  initPersonaPlexDecoder
};
