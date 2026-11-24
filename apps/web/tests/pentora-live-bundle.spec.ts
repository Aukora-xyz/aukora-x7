/**
 * The bundle pin. Auma Live loads the COMMITTED `/app/aura-trace.js` and `/app/aura-trace.css`; for
 * five days they were a stale React build of an older figure and nothing noticed. This rebuilds all three outputs of
 * build-auma-live-modules.mjs into a temporary folder inside the checkout (under the ignored `tmp/`) and compares
 * bytes with the committed files, so the committed bundle can never be stale again. It also holds the bundle small and
 * free of React.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const committed = path.join(root, 'apps/web/public/app')
const OUTPUTS = ['aura-trace.js', 'aura-trace.css', 'personaplex-audio.js'] as const
let fresh = ''

beforeAll(() => {
  mkdirSync(path.join(root, 'tmp'), { recursive: true })
  fresh = mkdtempSync(path.join(root, 'tmp', 'pentora-bundle-pin-'))
  const built = spawnSync(process.execPath, ['apps/web/scripts/stock-apps/build-auma-live-modules.mjs', fresh], { cwd: root, encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`the Auma Live module build failed: ${built.stderr}`)
}, 120_000)
afterAll(() => { if (fresh !== '') rmSync(fresh, { recursive: true, force: true }) })

describe('the committed Auma Live modules are exactly what their source builds', () => {
  it.each(OUTPUTS)('%s is byte-identical to a fresh build', (name) => {
    expect(readFileSync(path.join(fresh, name)).equals(readFileSync(path.join(committed, name)))).toBe(true)
  })

  it('the Pentora bundle is under 80 KB, carries no React, and exports the seam Auma Live imports', () => {
    const js = readFileSync(path.join(committed, 'aura-trace.js'), 'utf8')
    expect(Buffer.byteLength(js)).toBeLessThan(80 * 1024)
    expect(js).not.toMatch(/react/i)
    expect(js).toMatch(/export\s*\{[^}]*\bcreateAuraTrace\b[^}]*\}/)
    const auma = readFileSync(path.join(committed, 'aumalive.js'), 'utf8')
    expect(auma).toContain("import { createAuraTrace } from '/app/aura-trace.js';")
    const css = readFileSync(path.join(committed, 'aura-trace.css'), 'utf8')
    expect(css).toContain('.alv-app .alv-aura-trace.alv-pentora-live')
  })
})
