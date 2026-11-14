// BUILDS THE MANAGED VOICE.
//   apps/web/public/app/managed-voice.js       browser.mjs and the pinned SDK in one module, licence notices at the end
//   apps/web/public/app/eleven-raw-audio.js    the SDK's own capture worklet, copied from the pinned SDK (never hand-copied),
//                                              byte for byte except trailing spaces at line ends (see trimLineEnds)
// The SDK is `@elevenlabs/client` at exactly 1.36.0 (apps/web/package.json, pnpm-lock.yaml). Two ways, never mixed:
//   - AUKORA_MANAGED_VOICE_SDK unset: it resolves as any dependency of apps/web does, from browser.mjs up the folders,
//     so from apps/web/node_modules after `pnpm install` (pnpm links a direct dependency there).
//   - AUKORA_MANAGED_VOICE_SDK set: it resolves ONLY from <that folder>/node_modules (an isolated
//     `npm install --ignore-scripts @elevenlabs/client@1.36.0`), even when apps/web has its own install; a folder
//     without it is an error, never a quiet fall back to another copy (sdkFolderPlugin).
// Any other version is refused.
import { realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SDK_NAME = '@elevenlabs/client'
export const SDK_VERSION = '1.36.0'
/** The processor the pinned SDK registers; the copied worklet must register exactly this. */
export const SDK_WORKLET_PROCESSOR = 'rawAudioProcessor@6731b766e9e6176d'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '../../..')
const fromWeb = createRequire(path.join(webRoot, 'package.json'))
/** The esbuild that vite (a dependency of apps/web) carries. */
export const loadEsbuild = () => createRequire(fromWeb.resolve('vite'))('esbuild')

/**
 * The SDK taken from `<sdkDir>/node_modules` and from nowhere else: the import of `@elevenlabs/client` is resolved from
 * that folder before esbuild's own lookup (which would find apps/web's install first), and a result outside the
 * folder is refused. The SDK's own imports then resolve beside it, inside the same folder.
 */
export function sdkFolderPlugin(sdkDir) {
  const folder = realpathSync(path.resolve(sdkDir))
  const modules = path.join(folder, 'node_modules')
  return {
    name: 'managed-voice-sdk-folder',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^@elevenlabs\/client$/ }, async args => {
        if (args.pluginData?.sdkFolder) return undefined
        const found = await pluginBuild.resolve(args.path, { kind: args.kind, resolveDir: folder, importer: args.importer, pluginData: { sdkFolder: true } })
        if (found.errors.length) return { errors: found.errors }
        if (!found.path.startsWith(modules + path.sep)) return { errors: [{ text: `${SDK_NAME} is not in ${modules} (AUKORA_MANAGED_VOICE_SDK)` }] }
        return { path: found.path, namespace: found.namespace, sideEffects: found.sideEffects }
      })
    },
  }
}

/** The package root a resolved input file sits in (`.../node_modules/<name>`). */
function packageRootOf(file, name) {
  const marker = `${path.sep}node_modules${path.sep}${name.split('/').join(path.sep)}${path.sep}`
  const at = file.lastIndexOf(marker)
  return at < 0 ? '' : file.slice(0, at + marker.length - 1)
}

const commentSafe = text => text.replaceAll('*/', '* /')
/**
 * Trailing spaces at line ends removed, nothing else: the repository's commit hook (`git diff --cached --check`) refuses
 * them, and the SDK carries some inside its worklet source. Whitespace before a line break changes no JavaScript here
 * (it sits in the worklet's own source text); the processor name the SDK checks is untouched.
 */
export const trimLineEnds = text => text.replace(/[ \t]+$/gm, '')

/**
 * @param {{ outDir?: string, sdkDir?: string }} [options]
 * @returns {Promise<{ bundle: string, worklet: Buffer, sdkRoot: string }>}
 */
export async function buildManagedVoice({ outDir = path.join(webRoot, 'public/app'), sdkDir = process.env.AUKORA_MANAGED_VOICE_SDK } = {}) {
  const { build } = loadEsbuild()
  const result = await build({
    entryPoints: [path.join(here, 'browser.mjs')],
    bundle: true, write: false, metafile: true, absWorkingDir: webRoot,
    platform: 'browser', format: 'esm', target: 'es2022', charset: 'utf8', minify: true, sourcemap: false,
    legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [...(sdkDir ? [sdkFolderPlugin(sdkDir)] : []), {
      // No script from another origin: the SDK's CDN fallback for libsamplerate is replaced by a refusing stand-in.
      name: 'managed-voice-no-cdn',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /(^|\/)addLibsamplerateModule\.js$/ }, args => (
          packageRootOf(args.importer, SDK_NAME) ? { path: path.join(here, 'libsamplerate-absent.mjs') } : undefined
        ))
      },
    }],
  })
  const inputs = Object.keys(result.metafile.inputs).map(input => path.resolve(webRoot, input))
  const sdkRoots = new Set(inputs.map(input => packageRootOf(input, SDK_NAME)).filter(Boolean))
  if (sdkRoots.size !== 1) throw new Error(`${SDK_NAME} must be bundled from exactly one install, found ${sdkRoots.size}`)
  const [sdkRoot] = sdkRoots
  const manifest = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'))
  if (manifest.name !== SDK_NAME || manifest.version !== SDK_VERSION) {
    throw new Error(`${SDK_NAME} ${SDK_VERSION} is pinned; ${manifest.name}@${manifest.version} was found at ${sdkRoot}`)
  }
  const transportRoot = [...new Set(inputs.map(input => packageRootOf(input, 'livekit-client')).filter(Boolean))]
  if (transportRoot.length !== 1) throw new Error(`livekit-client must be bundled from exactly one install, found ${transportRoot.length}`)
  const transport = JSON.parse(await readFile(path.join(transportRoot[0], 'package.json'), 'utf8'))
  const notices = [
    [`${SDK_NAME}@${manifest.version}`, await readFile(path.join(sdkRoot, 'LICENSE'), 'utf8')],
    [`livekit-client@${transport.version}`, await readFile(path.join(transportRoot[0], 'LICENSE'), 'utf8')],
  ].map(([name, text]) => `/*! ${name}\n${commentSafe(text.trim())}\n*/`).join('\n')
  const code = new TextDecoder().decode(result.outputFiles[0].contents)
  const bundle = trimLineEnds(`// GENERATED by apps/web/scripts/stock-apps/managed-voice/build.mjs from managed-voice/browser.mjs: edit the source, then rebuild.\n${code}${notices}\n`)
  const worklet = Buffer.from(trimLineEnds(await readFile(path.join(sdkRoot, 'worklets/rawAudioProcessor.js'), 'utf8')), 'utf8')
  if (!worklet.toString('utf8').includes(`registerProcessor("${SDK_WORKLET_PROCESSOR}"`)) throw new Error(`the SDK worklet does not register ${SDK_WORKLET_PROCESSOR}`)
  await writeFile(path.join(outDir, 'managed-voice.js'), bundle)
  await writeFile(path.join(outDir, 'eleven-raw-audio.js'), worklet)
  return { bundle, worklet, sdkRoot }
}
