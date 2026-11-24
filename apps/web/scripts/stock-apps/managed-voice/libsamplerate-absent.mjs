// Stand-in for the SDK's `addLibsamplerateModule`: the SDK falls back to a CDN script when no path is
// given, and only its WebSocket voice path asks for it. The managed voice uses WebRTC, so nothing here loads a script
// from another origin; a caller that does need it must name a same-origin path.
export async function addLibsamplerateModule(context, customPath) {
  if (!customPath) throw new Error('libsamplerate is not bundled: name a same-origin libsampleratePath to use it')
  await context.audioWorklet.addModule(customPath)
}
