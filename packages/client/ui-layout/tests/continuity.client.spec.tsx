// @vitest-environment jsdom
/**
 * The Continuity screen's own parts (Wave 5): the Estate card (`GET /_host/estate`, drawn only as the host answers it),
 * the durability notes split (what was not read stays in sight; the long caveats wait under a closed Details row), the
 * System menu's Continuity button, and the field table's name column that can no longer crush its values.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { durabilityNotesOf, durabilityNoteOf, englishDurability, type DurabilityTile } from '../src/client/spatial/portal/durability.ts'
import { ESTATE_MAX_ROWS, ESTATE_ROUTE, EstateCell, estateRows } from '../src/client/spatial/portal/EstateCell.tsx'
import { SYSTEM_LAUNCHERS } from '../src/client/spatial/portal/menus.tsx'
import { CONTINUITY_SURFACE, SOVEREIGNTY_SURFACE } from '../src/client/spatial/portal/SovereigntySurface.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Continuity: the Estate card', () => {
  it('a host without the route says so in one line and draws no row', async () => {
    const fetch = vi.fn(async (_route: string, _init?: RequestInit) => new Response('nope', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    const { container } = render(<EstateCell active round={0} />)
    // The closed card already says it in its badge; its body is drawn once opened.
    await waitFor(() => { expect(container.textContent).toContain('NOT ON THIS HOST YET') })
    fireEvent.click(container.querySelector('button') as Element)
    expect(container.querySelector('[data-continuity-estate="absent"]')).not.toBeNull()
    expect(container.querySelector('[data-continuity-estate]')?.textContent).toContain('does not serve its estate yet')
    expect(container.querySelector('.ak-fields')).toBeNull()
    // One GET, to the estate route only, with the page's own cookie; never retried.
    expect(fetch.mock.calls.map(([route, init]) => [route, init?.method])).toEqual([[ESTATE_ROUTE, 'GET']])
  })

  it('a live answer (the edge\'s own shape) is drawn row by row: records opened by path, lists counted, flags shown, secrets never', async () => {
    // SOURCE: deploy/cloudflare/src/worker.mjs estateProjection + head-do.mjs /_head/estate (aukora.edge-estate.v1).
    const body = { ok: true, schema: 'aukora.edge-estate.v1', coverage: 'partial',
      head: { ballId: 'aa'.repeat(32), epoch: 168, lease: { active: false, expiresAt: null }, wake: { enabled: true, wakeCount: 3, autoPaused: false },
        repo: { staged: false, pending: false, lastOutcome: null }, transcript: { lastSequence: 1509 } },
      mirror: { entryCount: 412, fileCount: 390, highWater: 1509 }, archive: { configured: true, status: 'not-observed' },
      worker: { sourceRevision: 'c'.repeat(40), capabilities: { head: true, mirror: true, archive: true, browser: false },
        secretPresence: { GITHUB_TOKEN: true, DEEPSEEK_API_KEY: false } } }
    vi.stubGlobal('fetch', vi.fn(async () => json(body)))
    const { container } = render(<EstateCell active round={0} />)
    await waitFor(() => { expect(container.textContent).toContain('LIVE') })
    fireEvent.click(container.querySelector('button') as Element)
    expect(container.querySelector('[data-continuity-estate="live"]')).not.toBeNull()
    const rows = new Map(estateRows(body))
    expect(rows.get('head.epoch')).toBe('168')
    expect(rows.get('head.wake.enabled')).toBe('true')
    expect(rows.get('head.transcript.lastSequence')).toBe('1509')
    expect(rows.get('mirror.entryCount')).toBe('412')
    expect(rows.get('archive.status')).toBe('not-observed')
    expect(rows.get('worker.capabilities.browser')).toBe('false')
    // The host's secret-PRESENCE flags are shown (true/false says only that one is set), never a secret-shaped value.
    expect(rows.get('worker.secretPresence.GITHUB_TOKEN')).toBe('true')
    expect(rows.get('worker.secretPresence.DEEPSEEK_API_KEY')).toBe('false')
    const text = container.querySelector('[data-continuity-estate]')?.textContent ?? ''
    expect(text).toContain('head.wake.enabled')
    expect(text).toContain('worker.secretPresence.GITHUB_TOKEN')
    // Lists are counted, never printed; a non-boolean under a secret-shaped name is never drawn, at any depth.
    const hostile = { ok: true, apiKey: 'k1', nodePubkey: 'aa', sessions: ['sid-1', 'sid-2'], pin: 1, count: 2, alarms: [],
      secrets: { DEEPGRAM_API_KEY: 'sk-live', present: true }, deep: { a: { b: { c: { d: 1 } } }, recoveryPhrase: 'p', inviteCode: 'c' } }
    expect(estateRows(hostile)).toEqual([['nodePubkey', 'aa'], ['count', '2'], ['alarms', '0 entries'], ['secrets.present', 'true'],
      ['deep.a.b', '1 fields']])
    expect(JSON.stringify(estateRows(hostile))).not.toMatch(/k1|sk-live|sid-1/u)
    // A host cannot grow the page without bound.
    expect(estateRows(Object.fromEntries(Array.from({ length: 500 }, (_unused, index) => [`f${String(index)}`, index]))).length).toBe(ESTATE_MAX_ROWS)
  })

  it('a refusal shows the host\'s own code; a closed screen reads nothing', async () => {
    const fetch = vi.fn(async () => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401))
    vi.stubGlobal('fetch', fetch)
    const closed = render(<EstateCell active={false} round={0} />)
    await new Promise((done) => { setTimeout(done, 20) })
    expect(fetch).not.toHaveBeenCalled()
    closed.unmount()
    const { container } = render(<EstateCell active round={0} />)
    await waitFor(() => { expect(container.textContent).toContain('REFUSED') })
    fireEvent.click(container.querySelector('button') as Element)
    expect(container.querySelector('[data-continuity-estate="refused"]')).not.toBeNull()
    expect(container.querySelector('[data-continuity-estate]')?.textContent).toContain('OWNER_ACCESS_REQUIRED')
  })
})

describe('Continuity: notes, menu and the field table', () => {
  const tile = (over: Partial<DurabilityTile>): DurabilityTile => ({ id: 'head', name: 'Live HEAD', value: 'x', title: 'x', tone: 'muted',
    state: 'ok', detail: null, ...over } as DurabilityTile)

  it('what was not read and the caveats are two notes: the first always shown, the second for the Details row', () => {
    const tiles = [tile({ id: 'spend', name: 'Provider window', detail: 'reservations, not billing' }),
      tile({ id: 'cold-backup', name: 'R2 cold backup', state: 'unavailable', detail: '/api/health did not answer' }), tile({})]
    const notes = durabilityNotesOf(tiles, englishDurability)
    expect(notes.notRead).toBe('Not read: R2 cold backup: /api/health did not answer')
    expect(notes.caveats).toContain('Provider window: reservations, not billing')
    expect(notes.caveats).not.toContain('R2 cold backup')
    // Together they are exactly the one note the strip used to draw.
    expect(durabilityNoteOf(tiles, englishDurability)).toBe(`${String(notes.notRead)} — ${String(notes.caveats)}`)
    expect(durabilityNotesOf([tile({})], englishDurability)).toEqual({ notRead: null, caveats: null })
  })

  it('the System menu has a Continuity button right after Sovereignty, each opening its own surface', () => {
    expect(SYSTEM_LAUNCHERS.slice(0, 2).map(launcher => [launcher.id, launcher.title])).toEqual([[SOVEREIGNTY_SURFACE, 'Sovereignty'],
      [CONTINUITY_SURFACE, 'Continuity']])
    expect(new Set(SYSTEM_LAUNCHERS.map(launcher => launcher.id)).size).toBe(SYSTEM_LAUNCHERS.length)
  })

  it('the field table caps its name column at 38% with valid CSS, and a long name wraps instead of crushing the value', () => {
    const css = readFileSync(resolve(__dirname, '../src/client/spatial/primitives/primitives.css'), 'utf8')
    const rule = /\.ak-fields \{[^}]*\}/u.exec(css)?.[0] ?? ''
    expect(rule).toContain('grid-template-columns: fit-content(38%) minmax(0, 1fr);')
    // `max-content` inside min() is not CSS: a browser drops the whole declaration and the table loses its columns.
    expect(css).not.toMatch(/min\([^)]*max-content/u)
    expect(/\.ak-fields dt \{[^}]*\}/u.exec(css)?.[0]).toContain('overflow-wrap: anywhere')
  })
})
