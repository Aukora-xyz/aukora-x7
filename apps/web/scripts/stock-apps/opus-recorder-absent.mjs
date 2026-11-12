// x6.1 stand-in for the `opus-recorder` package, which x6.1 does not ship. PersonaPlex's own server is also absent on
// x6.1, so a PersonaPlex start fails either way; this makes it fail with a sentence instead of a missing-module crash.
export default class OpusRecorderAbsent {
  constructor() {
    throw new Error('PersonaPlex voice is not available on x6.1: opus-recorder is not bundled and no PersonaPlex server runs')
  }
}
