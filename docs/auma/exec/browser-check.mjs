// HANDS1 worked example (c) of docs/auma/exec.md: load a built app/web in headless Chromium inside an x6_exec runner.
// Run it there with `browser: true`, after the build, from the repository root:
//   node docs/auma/exec/browser-check.mjs [port]
// It serves apps/web/dist on 127.0.0.1 (no network beyond the runner), opens it with the Playwright that auma-exec.yml
// installed (X61_PLAYWRIGHT_DIR, pinned 1.61.1), writes a screenshot to $ARTIFACTS/app.png and prints the page's console
// errors and failed requests. Exit 1 when the page has a console error or did not load. It reads no secret and writes
// only under $ARTIFACTS.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join, normalize, resolve } from 'node:path'

const root = resolve('apps/web/dist')
const out = process.env.ARTIFACTS
const port = Number(process.argv[2] ?? 4317)
if (!existsSync(join(root, 'index.html'))) { console.error(`no build at ${root}: build it first`); process.exit(1) }
if (!out) { console.error('ARTIFACTS is not set: run this inside an x6_exec runner'); process.exit(1) }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }

const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)).replace(/^([/\\])+/, '')
  let file = join(root, path)
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(response)
})
await new Promise(done => server.listen(port, '127.0.0.1', done))

const require = createRequire(join(process.env.X61_PLAYWRIGHT_DIR ?? resolve('apps/web'), 'package.json'))
const { chromium } = require('playwright')
const browser = await chromium.launch()
const errors = [], failed = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(String(error)))
  page.on('requestfailed', request => failed.push(`${request.url()} ${request.failure()?.errorText ?? ''}`))
  const answer = await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: join(out, 'app.png'), fullPage: true })
  console.log(`loaded: HTTP ${answer?.status() ?? 'none'}, title "${await page.title()}"; screenshot $ARTIFACTS/app.png`)
  console.log(`console errors: ${errors.length}`)
  for (const line of errors) console.log(`  ${line}`)
  console.log(`failed requests: ${failed.length}`)
  for (const line of failed) console.log(`  ${line}`)
  process.exitCode = answer?.ok() && errors.length === 0 ? 0 : 1
} finally {
  await browser.close()
  server.close()
}
