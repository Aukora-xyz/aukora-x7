#!/usr/bin/env node
// Build the two Auma Live modules the predecessor produced in its own build (an earlier repository):
//   apps/web/public/app/aura-trace.js (+ .css)   the Pentora echo behind Auma Live's voice field
//   apps/web/public/app/personaplex-audio.js     PersonaPlex audio, with `opus-recorder` replaced by a refusing stand-in
// Run from the repository root: node apps/web/scripts/stock-apps/build-auma-live-modules.mjs
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// esbuild is not a direct dependency of apps/web: use the copy Vite (which is) resolves.
const fromWeb = createRequire(path.resolve(here, '../../package.json'))
const { build } = createRequire(fromWeb.resolve('vite'))('esbuild')
const out = path.resolve(here, '../../public/app')
const common = {
  bundle: true, platform: 'browser', format: 'esm', target: 'chrome130', charset: 'utf8', minify: false,
  sourcemap: false, legalComments: 'inline', define: { 'process.env.NODE_ENV': '"production"' },
}
await build({
  ...common,
  entryPoints: [path.join(here, 'auma-live-trace.mjs')],
  outfile: path.join(out, 'aura-trace.js'),
  jsx: 'automatic',
  loader: { '.module.css': 'local-css' },
})
await build({
  ...common,
  entryPoints: [path.join(here, 'personaplex-audio.js')],
  outfile: path.join(out, 'personaplex-audio.js'),
  alias: { 'opus-recorder': path.join(here, 'opus-recorder-absent.mjs') },
})
console.log('built', path.relative(process.cwd(), out), ['aura-trace.js', 'aura-trace.css', 'personaplex-audio.js'].join(' '))
