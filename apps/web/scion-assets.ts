/** Package the pinned compiler beside the preview worker; no runtime CDN fetch. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type { Plugin } from 'vite'
import { SCION_COMPILER } from '../../packages/experimental/webworker-runtime/src/x6/scion-pins.ts'

/** Emit only an artifact that matches the source-pinned compiler digest. */
export function scionCompilerAssets(): Plugin {
  const require = createRequire(new URL('../../packages/experimental/webworker-runtime/package.json', import.meta.url))
  return {
    name: 'aukora-scion-compiler-assets',
    async generateBundle() {
      const source = await readFile(require.resolve('esbuild-wasm/esbuild.wasm'))
      if (source.length !== SCION_COMPILER.wasmBytes || createHash('sha256').update(source).digest('hex') !== SCION_COMPILER.wasmSha256) throw new Error('Scion compiler artifact pin mismatch')
      this.emitFile({ type: 'asset', fileName: 'preview/' + SCION_COMPILER.asset, source })
      this.emitFile({ type: 'asset', fileName: 'preview/scion/LICENSE-esbuild.txt', source: await readFile(require.resolve('esbuild-wasm/LICENSE.md')) })
    },
  }
}
