// @vitest-environment jsdom
/** The night-grant section shows only the answer of the current read; a stalled refresh or reopen says
 * Reading, never the previous answer. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { NightGrantCell } from '../src/client/spatial/portal/NightGrantCell.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const setup = () => {
  let stall = false
  vi.stubGlobal('fetch', vi.fn(async () => (stall ? new Promise<Response>(() => {}) : new Response(JSON.stringify({ ok: true, nightGrant: null })))))
  const view = render(<NightGrantCell active round={0} />)
  return { view, stallNow: () => { stall = true } }
}

describe('night grant section, per read', () => {
  it('a Refresh whose read stalls says Reading, not the previous "No night grant"', async () => {
    const t = setup()
    await waitFor(() => { expect(t.view.container.textContent).toContain('No night grant') })
    t.stallNow()
    t.view.rerender(<NightGrantCell active round={1} />)
    expect(t.view.container.textContent).not.toContain('No night grant')
    await new Promise((done) => { setTimeout(done, 80) })
    expect(t.view.container.textContent).toContain('Reading the night grant')
    expect(t.view.container.textContent).not.toContain('No night grant')
  })

  it('close and reopen with the read stalled says Reading, not the previous answer', async () => {
    const t = setup()
    await waitFor(() => { expect(t.view.container.textContent).toContain('No night grant') })
    t.stallNow()
    t.view.rerender(<NightGrantCell active={false} round={0} />)
    t.view.rerender(<NightGrantCell active round={0} />)
    await new Promise((done) => { setTimeout(done, 80) })
    expect(t.view.container.textContent).toContain('Reading the night grant')
    expect(t.view.container.textContent).not.toContain('No night grant')
  })
})
