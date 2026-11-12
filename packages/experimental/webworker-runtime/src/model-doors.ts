/**
 * Aukora model doors: routes known model providers through same-origin `/door/<name>/...`
 * so the local host / Cloudflare Vault can inject server-held keys or proxy user-configured keys
 * without browser CORS errors. No provider or origin is ever blocked.
 */
// Each upstream is the base the edge (`deploy/cloudflare/src/worker.mjs` PROVIDERS) and the Mac host
// (`server/local-host.mjs` DOOR_UPSTREAMS) prepend to the door path, so `/v1/...` stays in the door path:
// https://openrouter.ai/api/v1/chat/completions -> /door/openrouter/v1/chat/completions -> the same upstream URL.
export const MODEL_DOORS: ReadonlyArray<readonly [upstream: string, door: string]> = [
  ['https://api.deepseek.com/', 'deepseek'],
  ['https://api.moonshot.ai/', 'moonshot'],
  ['https://api.moonshot.cn/', 'moonshot-cn'],
  ['https://openrouter.ai/api/', 'openrouter'],
  ['https://api.openai.com/', 'openai'],
  ['https://api.anthropic.com/', 'anthropic'],
  ['https://api.x.ai/', 'xai'],
]

const DOOR_UPSTREAMS = MODEL_DOORS.map(([upstream, door]) => {
  const u = new URL(upstream)
  return { origin: u.origin, upstream, door }
})

export function modelDoorFor(url: string, origin: string): string | null {
  let u: URL
  try {
    u = new URL(url, origin)
  } catch {
    return url
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return url
  if (u.username === '' && u.password === '') {
    for (const d of DOOR_UPSTREAMS) {
      if (u.origin === d.origin && u.href.startsWith(d.upstream)) {
        return `${origin}/door/${d.door}/${u.href.slice(d.upstream.length)}`
      }
    }
  }
  return url
}

export const isModelDoor = (url: string, origin: string): boolean => url.startsWith(`${origin}/door/`)
