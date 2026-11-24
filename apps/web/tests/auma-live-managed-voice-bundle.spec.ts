/**
 * THE MANAGED VOICE BUNDLE.
 * The served files are what the source and the pinned SDK build: managed-voice.js and eleven-raw-audio.js are rebuilt
 * here into a temporary folder inside the checkout and compared byte for byte. The bundle carries no key-shaped string,
 * no script from another origin, and the licence notices of the SDK and its transport; only one module imports the SDK.
 *
 * The rebuild needs @elevenlabs/client 1.36.0 installed (pnpm install), or AUKORA_MANAGED_VOICE_SDK naming a folder whose
 * node_modules carries it (see managed-voice/build.mjs). Without either it fails and says so.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const app = (name: string) => new URL(`../public/app/${name}`, import.meta.url)
const bundle = readFileSync(app('managed-voice.js'), 'utf8')
const worklet = readFileSync(app('eleven-raw-audio.js'))
const sourceDir = new URL('../scripts/stock-apps/managed-voice/', import.meta.url)
type Built = { metafile: { inputs: Record<string, unknown> }; outputFiles: Array<{ text: string }> }
type Esbuild = { build: (options: Record<string, unknown>) => Promise<Built> }
const { buildManagedVoice, trimLineEnds, loadEsbuild, sdkFolderPlugin, SDK_VERSION, SDK_WORKLET_PROCESSOR } = await import(new URL('build.mjs', sourceDir).href) as {
  buildManagedVoice: (options: { outDir: string }) => Promise<{ bundle: string; worklet: Buffer; sdkRoot: string }>
  trimLineEnds: (text: string) => string
  loadEsbuild: () => Esbuild
  sdkFolderPlugin: (sdkDir: string) => unknown
  SDK_VERSION: string
  SDK_WORKLET_PROCESSOR: string
}

describe('managed-voice.js and eleven-raw-audio.js', () => {
  it('are exactly what the source and the pinned SDK build (rebuilt here into a temporary folder)', { timeout: 60_000 }, async () => {
    const scratch = mkdtempSync(fileURLToPath(new URL('../.managed-voice-rebuild-', import.meta.url)))
    try {
      let rebuilt
      try {
        rebuilt = await buildManagedVoice({ outDir: scratch })
      } catch (error) {
        throw new Error(`the managed voice could not be rebuilt: install @elevenlabs/client ${SDK_VERSION} (pnpm install) or set AUKORA_MANAGED_VOICE_SDK. ${String(error)}`)
      }
      expect(readdirSync(scratch).sort()).toEqual(['eleven-raw-audio.js', 'managed-voice.js'])
      expect(readFileSync(`${scratch}/managed-voice.js`).equals(Buffer.from(bundle, 'utf8'))).toBe(true)
      expect(readFileSync(`${scratch}/eleven-raw-audio.js`).equals(worklet)).toBe(true)
      // The worklet is the pinned SDK's own file, byte for byte apart from trailing spaces at line ends (the commit
      // hook refuses those); nothing else differs, not even a line.
      const sdkWorklet = readFileSync(`${rebuilt.sdkRoot}/worklets/rawAudioProcessor.js`, 'utf8')
      expect(Buffer.from(trimLineEnds(sdkWorklet), 'utf8').equals(worklet)).toBe(true)
      expect(sdkWorklet.split('\n').map(line => line.trimEnd())).toEqual(worklet.toString('utf8').split('\n'))
      expect(trimLineEnds('a  \n\tb\t\n c ')).toBe('a\n\tb\n c')
      expect((JSON.parse(readFileSync(`${rebuilt.sdkRoot}/package.json`, 'utf8')) as { version: string }).version).toBe('1.36.0')
      // Where it came from: the named folder when AUKORA_MANAGED_VOICE_SDK is set, apps/web's own install when it is not.
      const named = process.env.AUKORA_MANAGED_VOICE_SDK
      if (named) expect(rebuilt.sdkRoot.startsWith(join(realpathSync(named), 'node_modules'))).toBe(true)
      else expect(rebuilt.sdkRoot).toBe(realpathSync(fileURLToPath(new URL('../node_modules/@elevenlabs/client', import.meta.url))))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('the SDK resolves from apps/web\'s install without AUKORA_MANAGED_VOICE_SDK, and only from the named folder with it (made-up folders)', async () => {
    const scratch = realpathSync(mkdtempSync(fileURLToPath(new URL('../.managed-voice-resolver-', import.meta.url))))
    const put = (file: string, text: string) => {
      mkdirSync(dirname(join(scratch, file)), { recursive: true })
      writeFileSync(join(scratch, file), text)
    }
    const sdk = (where: string, version: string, word: string) => {
      put(`${where}/node_modules/@elevenlabs/client/package.json`, JSON.stringify({ name: '@elevenlabs/client', version, main: 'index.js' }))
      put(`${where}/node_modules/@elevenlabs/client/index.js`, `export const Conversation = '${word}'\n`)
    }
    try {
      // An app with its own install (as apps/web after pnpm install), and a separate named folder.
      put('app/entry.mjs', "import { Conversation } from '@elevenlabs/client'\nexport default Conversation\n")
      sdk('app', '9.9.9', 'from-install')
      sdk('named', '1.36.0', 'from-named-folder')
      mkdirSync(join(scratch, 'empty'))
      const { build } = loadEsbuild()
      const bundle = (plugins: unknown[]) => build({ entryPoints: [join(scratch, 'app/entry.mjs')], bundle: true, write: false, format: 'esm', metafile: true, logLevel: 'silent', plugins })
      const plain = await bundle([])
      expect(plain.outputFiles[0]?.text).toContain('from-install')
      const named = await bundle([sdkFolderPlugin(join(scratch, 'named'))])
      expect(named.outputFiles[0]?.text).toContain('from-named-folder')
      expect(named.outputFiles[0]?.text).not.toContain('from-install')
      expect(Object.keys(named.metafile.inputs).some(input => input.includes('named/node_modules/@elevenlabs/client'))).toBe(true)
      // A named folder without the SDK is an error, never a quiet fall back to the app's install.
      await expect(bundle([sdkFolderPlugin(join(scratch, 'empty'))])).rejects.toThrow()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('the worklet registers the processor this SDK asks for, and the bundle asks for the same one', () => {
    expect(SDK_WORKLET_PROCESSOR).toBe('rawAudioProcessor@6731b766e9e6176d')
    expect(worklet.toString('utf8')).toContain(`registerProcessor("${SDK_WORKLET_PROCESSOR}"`)
    expect(bundle).toContain(SDK_WORKLET_PROCESSOR)
  })

  it('carries no key-shaped string', () => {
    for (const pattern of [
      /sk_[A-Za-z0-9]{16,}/, /xi-api-key/i, /agent_[a-z0-9]{16,}/, /-----BEGIN [A-Z ]*KEY-----/, /AKIA[0-9A-Z]{16}/,
      /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /\b[A-Fa-f0-9]{40,}\b/, /Bearer [A-Za-z0-9._-]{20,}/,
    ]) expect(bundle, String(pattern)).not.toMatch(pattern)
    expect(worklet.toString('utf8')).not.toMatch(/sk_[a-z0-9]{16,}|xi-api-key/i)
  })

  it('loads no script from another origin: every address in it is known, and none is a script host', () => {
    const addresses = [...new Set(bundle.match(/(?:https?|wss?):\/\/[^"'`\s)\\]*/g) ?? [])].sort()
    expect(addresses).toEqual([
      'http://',
      'http://www.apache.org/licenses/',
      'https://',
      'https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension',
      'https://api.elevenlabs.io',
      'https://github.com/rochars/wavefile/blob/master/lib/codecs/mulaw.js',
      'wss://api.elevenlabs.io',
      'wss://livekit.rtc.elevenlabs.io',
    ])
    expect(bundle).not.toMatch(/jsdelivr|unpkg|cdnjs|importScripts\(|import\(\s*["'`]https?:/)
    expect(bundle).not.toMatch(/addModule\(\s*["'`]https?:/)
  })

  it('keeps the licence notices of the SDK and its transport', () => {
    expect(bundle).toMatch(/\/\*! @elevenlabs\/client@1\.36\.0\n/)
    expect(bundle).toMatch(/\/\*! livekit-client@\d+\.\d+\.\d+\n[\s\S]*Apache License/)
  })

  it('only browser.mjs imports the SDK, and no page script does', () => {
    const files = readdirSync(sourceDir).filter(name => name.endsWith('.mjs'))
    const importers = files.filter(name => readFileSync(new URL(name, sourceDir), 'utf8').includes('from \'@elevenlabs/client\''))
    expect(importers).toEqual(['browser.mjs'])
    for (const page of ['aumalive.js', 'genesis-live.js']) expect(readFileSync(app(page), 'utf8')).not.toContain('@elevenlabs/client')
    expect(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).toContain('"@elevenlabs/client": "1.36.0",')
  })
})
