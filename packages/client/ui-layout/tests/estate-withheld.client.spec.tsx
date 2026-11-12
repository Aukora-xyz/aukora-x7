// @vitest-environment jsdom
/**
 * the Continuity screen's Estate card shows how many stored entries the secret-path rule
 * withholds, from the edge's own estate answer (`mirror.withheldEntries`), as one row in plain words when that count is
 * above 0, and nothing at all when it is 0. The edge's own line (`mirror.pathRuleNote`) is never drawn beside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { EstateCell, estateRows, WITHHELD_WORDS } from '../src/client/spatial/portal/EstateCell.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** The edge's answer shape (deploy/cloudflare/src/worker.mjs estateProjection), with the mirror's withheld count. */
const estate = (withheld: number) => ({ ok: true, schema: 'aukora.edge-estate.v1', coverage: 'partial', head: { ballId: 'aa'.repeat(32), epoch: 170 },
  mirror: { entryCount: 412, fileCount: 390, directoryCount: 22, highWater: 1509, snapshotETag: '"x61-mirror-snapshot-v2:11111111-1111-4111-8111-111111111111:1509:r5"',
    withheldEntries: withheld, pathRuleNote: `entries withheld by the secret-path rule: ${String(withheld)}` },
  archive: { configured: true, status: 'not-observed' } })

async function drawn(withheld: number): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(async () => json(estate(withheld))))
  const { container } = render(<EstateCell active round={0} />)
  await waitFor(() => { expect(container.textContent).toContain('LIVE') })
  fireEvent.click(container.querySelector('button') as Element)
  return container.querySelector('[data-continuity-estate="live"]')?.textContent ?? ''
}

describe('Continuity: the Estate card names what the secret-path rule withholds', () => {
  it('N = 3: one row says "entries withheld by the secret-path rule: 3"; the edge\'s own line is not drawn twice', async () => {
    const rows = estateRows(estate(3))
    expect(rows.filter(([name]) => name.startsWith('mirror.'))).toEqual([['mirror.entryCount', '412'], ['mirror.fileCount', '390'],
      ['mirror.directoryCount', '22'], ['mirror.highWater', '1509'], ['mirror.snapshotETag', '"x61-mirror-snapshot-v2:11111111-1111-4111-8111-111111111111:1509:r5"'],
      ['mirror.withheldEntries', 'entries withheld by the secret-path rule: 3']])
    const text = await drawn(3)
    expect(text).toContain(`${WITHHELD_WORDS}: 3`)
    expect(text.split(WITHHELD_WORDS)).toHaveLength(2)
    expect(text).not.toContain('pathRuleNote')
  })

  it('N = 0: nothing is drawn for it', async () => {
    const rows = estateRows(estate(0))
    expect(rows.some(([name, value]) => name.includes('withheld') || name.includes('pathRuleNote') || value.includes(WITHHELD_WORDS))).toBe(false)
    const text = await drawn(0)
    expect(text).not.toContain(WITHHELD_WORDS)
    expect(text).not.toContain('withheldEntries')
    expect(text).toContain('mirror.entryCount')
  })

  it('a count that is not a whole number above 0 is never drawn as one, and an answer without it draws as before', () => {
    for (const odd of [-1, 1.5, Number.NaN, '3', null]) {
      const body = { mirror: { entryCount: 1, withheldEntries: odd } }
      expect(estateRows(body)).toEqual([['mirror.entryCount', '1']])
    }
    expect(estateRows({ mirror: { entryCount: 1 } })).toEqual([['mirror.entryCount', '1']])
  })
})
