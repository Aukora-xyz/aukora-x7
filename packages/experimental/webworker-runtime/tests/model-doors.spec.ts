import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MODEL_DOORS, modelDoorFor } from '../src/model-doors.ts'

const ORIGIN = 'https://x61.example.invalid'

/** The provider bases a door forwards to: the edge's PROVIDERS and the Mac host's DOOR_UPSTREAMS, read from source. */
async function forwardBases(file: string, field: 'origin' | 'base'): Promise<Map<string, string>> {
  const text = await readFile(new URL(`../../../../${file}`, import.meta.url), 'utf8')
  const bases = new Map<string, string>()
  for (const match of text.matchAll(new RegExp(String.raw`^\s*'?([a-z0-9-]+)'?: \{ ${field}: '(https://[^']+)'`, 'gm'))) {
    bases.set(match[1] as string, match[2] as string)
  }
  return bases
}

describe('model doors', () => {
  it('keep each provider URL whole from the page, through the door, to the upstream the edge and the Mac call', async () => {
    const edge = await forwardBases('deploy/cloudflare/src/worker.mjs', 'origin')
    const mac = await forwardBases('server/local-host.mjs', 'base')
    const urls = [
      'https://api.deepseek.com/chat/completions',
      'https://api.moonshot.ai/v1/chat/completions',
      'https://api.moonshot.cn/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
      'https://api.anthropic.com/v1/chat/completions',
      'https://api.anthropic.com/v1/messages',
      'https://api.x.ai/v1/chat/completions',
    ]
    expect(new Set(MODEL_DOORS.map(([, door]) => door))).toEqual(new Set(edge.keys()))
    for (const url of urls) {
      const door = modelDoorFor(url, ORIGIN)
      const match = door?.match(/^https:\/\/x61\.example\.invalid\/door\/([a-z0-9-]+)(\/.*)$/)
      expect(match, url).not.toBeNull()
      const [, provider, path] = match as RegExpMatchArray
      // The edge only serves these paths; the door path must be one of them.
      expect(path, url).toMatch(/^\/(?:(?:anthropic\/)?v1\/)?(?:models|chat\/completions|messages|responses)$/)
      expect(`${edge.get(provider as string) ?? ''}${path as string}`, `edge ${url}`).toBe(url)
      expect(`${mac.get(provider as string) ?? ''}${path as string}`, `mac ${url}`).toBe(url)
    }
  })

  it('leaves other hosts alone', () => {
    expect(modelDoorFor('https://example.com/v1/chat/completions', ORIGIN)).toBe('https://example.com/v1/chat/completions')
  })
})
