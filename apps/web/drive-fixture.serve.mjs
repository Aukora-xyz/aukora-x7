// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * Serve the drive fixture page from this checkout, with no build: the repo's own Vite, React plugin and tsconfig paths
 * (the same source resolution the client specs use), bound to 127.0.0.1 only, on a fixed port.
 *
 *   node apps/web/drive-fixture.serve.mjs   -> http://127.0.0.1:4178/          her drive
 *                                              http://127.0.0.1:4178/?chat=1   with a made-up chat message beside it
 *
 * Only the fixture's own HTML is served as a page; it calls no host, signs nothing in and posts nothing. Stop it with
 * Ctrl-C. `DRIVE_FIXTURE_PORT` picks another port.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

const web = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(web, '../..')
const port = Number(process.env.DRIVE_FIXTURE_PORT ?? 4178)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`drive fixture: bad port ${String(process.env.DRIVE_FIXTURE_PORT)}`)
if (port === 4610 || port === 3099) throw new Error('drive fixture: that port belongs to her host; pick another')

const PAGE = '/drive-fixture.html'
/** Only the fixture page is a page here: `/` is it, and the app's own index.html (which would boot her) is not served. */
const fixtureOnly = {
  name: 'drive-fixture-only-page',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/') {
        response.statusCode = 302
        response.setHeader('location', PAGE + url.search)
        response.end()
        return
      }
      if (url.pathname.endsWith('.html') && url.pathname !== PAGE) {
        response.statusCode = 404
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        response.end(`Only ${PAGE} is served here.\n`)
        return
      }
      next()
    })
  },
}

const server = await createServer({
  configFile: false,
  root: web,
  base: '/',
  appType: 'mpa',
  publicDir: false,
  // Vite's dependency cache stays inside this checkout (.cache/ is ignored by git), never in a shared node_modules.
  cacheDir: resolve(repo, '.cache/drive-fixture-vite'),
  plugins: [fixtureOnly, tsconfigPaths({ projects: [resolve(repo, 'tsconfig.base.json')] }), react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [{ find: /^node:module$/, replacement: resolve(web, 'src/node-module-stub.ts') }],
  },
  define: {
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
  optimizeDeps: { entries: [resolve(web, 'drive-fixture.html')] },
  server: { host: '127.0.0.1', port, strictPort: true, open: false, fs: { allow: [repo] } },
  clearScreen: false,
})
await server.listen()
process.stdout.write([
  'Drive fixture (made-up files, nothing leaves this machine):',
  `  http://127.0.0.1:${String(port)}/          her drive`,
  `  http://127.0.0.1:${String(port)}/?chat=1   a made-up chat message whose links open the drive`,
  '',
].join('\n'))
