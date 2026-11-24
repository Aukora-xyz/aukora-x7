// @vitest-environment jsdom
/**
 * The fixture page's nine Cloudflare asks (`?outward=<name>`, tests/drive-fixture/outward.tsx), mounted
 * headless as the page mounts them: the real Spatial frame, the real outward card, her made-up staged file read through
 * the real read and parse path. For each: the sentences the card says, the body row is the canonical text of her staged
 * body, and what the approve control hands the stand-ins is exactly `canonicalJson({ ...body, expect: protection })`
 * (the binding's digest and the send). `cf-changed`: one sentence, no second offer of the same bytes. Nothing real is
 * called: the stand-ins record, and the page's own guard refuses every network attempt.
 *
 * The six Linear asks (`lin-*`) on the same card: the sentence, every field as a row, and the bytes handed
 * to the stand-ins are exactly `canonicalJson(body)` (no reason object), bound to `/_host/linear`.
 */
import { createHash } from 'node:crypto'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../src/client/spatial/aumlok/class3-approval.ts'
import {
  CLOUDFLARE_REASON_CHANGED_WORDS, CLOUDFLARE_REASON_WHY, linearWords, resetReasonChangedForTests,
} from '../src/client/spatial/aumlok/outward-class3.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import { DriveFixture, refuseNetwork, type RefusedAttempt } from './drive-fixture/fixture.tsx'
import { OUTWARD_FIXTURES, outwardRunOf } from './drive-fixture/outward.tsx'
import { fixtureWorld } from './drive-fixture/world.ts'

let refused: readonly RefusedAttempt[] = []
beforeEach(() => {
  refused = refuseNetwork()
  localStorage.clear()
  vi.stubGlobal('innerWidth', 1440)
  vi.stubGlobal('matchMedia', (query: string) => ({ media: query, matches: false,
    addEventListener: () => {}, removeEventListener: () => {} }))
})
afterEach(() => { cleanup(); resetReasonChangedForTests(); resetApprovalsForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const SAID: Readonly<Record<string, readonly string[]>> = {
  'cf-dns': ['P1/live-zone'],
  'cf-switch': ['P1/account-switch'],
  'cf-storage': ['P1/bound-storage'],
  'cf-secret': ['P2/app-secret'],
  'cf-zone-delete': ['P3/zone-deletion'],
  'cf-charge': ['P4/registrar-renewal', 'P1/live-domain'],
  'cf-unresolved': ['P1/live-facts-unresolved'],
  'cf-long': ['P1/live-worker'],
  'cf-changed': ['P1/live-zone'],
}

function mount(name: string) {
  const run = outwardRunOf(name)!
  const world = fixtureWorld({ latencyMs: 0, now: new Date(2026, 10, 13, 18, 0).getTime() })
  vi.stubGlobal('__AUKORA_SUPERAGENT__', world.bridge)
  const view = render(<DriveFixture chat={false} world={world} outward={run} />)
  return { run, view }
}

/** The six Linear asks and the sentence the card says for each. */
const LINEAR_SAID: Readonly<Record<string, string>> = {
  'lin-issue-delete': 'Delete issue YOURTEAM-123 from Linear. This cannot be undone.',
  'lin-issue-archive': 'Archive issue YOURTEAM-124 in Linear.',
  'lin-project-archive': 'Archive project made-up-project-0001 in Linear.',
  'lin-team-member-remove': 'Remove a person from a team in Linear: membership made-up-membership-0001.',
  'lin-issue-move': 'Move issue YOURTEAM-125 to team made-up-team-0002.',
  'lin-long': `Change team M${'a'.repeat(63)}'s settings: description, key, name and privacy.`,
}

describe('the fixture page\'s Cloudflare asks on the owner\'s real card', () => {
  it('names exactly the nine Cloudflare asks and the six Linear ones', () => {
    expect(Object.keys(OUTWARD_FIXTURES).sort()).toEqual([...Object.keys(SAID), ...Object.keys(LINEAR_SAID)].sort())
    expect(outwardRunOf('not-a-name')).toBeNull()
  })

  for (const name of Object.keys(SAID)) {
    it(`${name}: the sentences, the rows, and exactly the approved bytes handed to the stand-ins`, async () => {
      const { run, view } = mount(name)
      const page = view.container
      expect(page.querySelector('[data-drive-fixture="outward"]')).not.toBeNull()
      const why = await waitFor(() => {
        const row = page.querySelector('[data-outward-fixture] [data-outward-field="why"]')
        expect(row).not.toBeNull()
        return row!
      })
      expect(why.textContent.split('\n')).toEqual(SAID[name]?.map(key => CLOUDFLARE_REASON_WHY[key]))
      const field = (row: string): string | null => [...page.querySelectorAll('[data-outward-field]')]
        .find(node => node.getAttribute('data-outward-field') === row)?.textContent ?? null
      const { body, protection } = run.ask
      // The body row with whitespace removed is the canonical text of her staged body with whitespace removed (her strings
      // keep their own spaces), and read back as JSON it is exactly that canonical text.
      const unspaced = (text: string): string => text.replace(/\s+/gu, '')
      if (body.body === undefined) expect(field('body')).toBeNull()
      else {
        expect(unspaced(field('body')!)).toBe(unspaced(canonicalJson(body.body)))
        expect(canonicalJson(JSON.parse(field('body')!))).toBe(canonicalJson(body.body))
      }
      expect([field('method'), field('path')]).toEqual([body.method, body.path])
      expect(page.innerHTML).not.toContain('"expect"')
      if (name === 'cf-long') {
        const module = (body.parts as Array<Record<string, unknown>>)[1]!.text as string
        expect(module).toHaveLength(60_000)
        expect(field('part 2 (worker.js) content')).toBe(module)
      }
      const approved = canonicalJson({ ...body, expect: protection })
      if (name !== 'cf-changed') fireEvent.click(page.querySelector<HTMLButtonElement>('[data-outward-approve]')!)
      const outcome = await waitFor(() => {
        const said = page.querySelector('[data-outward-outcome="sent"], [data-outward-outcome="refused"]')
        expect(said).not.toBeNull()
        return said!
      })
      expect(run.record.bindings).toHaveLength(1)
      expect(run.record.bindings[0]).toMatchObject({ method: 'POST', pathname: '/_host/cloudflare', bodySha256: sha256(approved) })
      expect(run.record.sends.map(send => [send.url, send.method, send.canonical])).toEqual([['/_host/cloudflare', 'POST', approved]])
      expect(page.querySelector('[data-outward-fixture-send]')?.textContent?.startsWith(approved.slice(0, 200))).toBe(true)
      if (name === 'cf-changed') {
        expect(outcome.getAttribute('data-outward-outcome')).toBe('refused')
        expect(outcome.textContent).toBe(CLOUDFLARE_REASON_CHANGED_WORDS)
        // No retry of the same bytes: the approve control is gone, and the card asks nothing more.
        await waitFor(() => { expect(page.querySelector('[data-outward-approve]')).toBeNull() })
        expect(page.textContent).not.toContain('app-secret')
        await new Promise(resolve => setTimeout(resolve, 150))
        expect(run.record.sends).toHaveLength(1)
      } else {
        expect(outcome.getAttribute('data-outward-outcome')).toBe('sent')
        expect(outcome.textContent).toBe('Sent.')
      }
      // Nothing on the page reached for the edge itself: the send went to the stand-in only.
      expect(refused.filter(attempt => attempt.url.includes('/_host/cloudflare') || attempt.url.includes('/_host/aumlok'))).toEqual([])
    })
  }
})

describe('the fixture page\'s Linear asks on the owner\'s real card', () => {
  for (const [name, sentence] of Object.entries(LINEAR_SAID)) {
    it(`${name}: the sentence, every field as a row, and exactly her bytes handed to the stand-ins`, async () => {
      const { run, view } = mount(name)
      const page = view.container
      const does = await waitFor(() => {
        const row = page.querySelector('[data-outward-fixture] [data-outward-field="does"]')
        expect(row).not.toBeNull()
        return row!
      })
      const { body } = run.ask
      expect(does.textContent).toBe(sentence)
      expect(linearWords(body).sentence).toBe(sentence)
      const field = (row: string): string | null => [...page.querySelectorAll('[data-outward-field]')]
        .find(node => node.getAttribute('data-outward-field') === row)?.textContent ?? null
      // Every field that leaves is a row, whole (lin-long: the longest name, description and ids the edge allows).
      for (const [key, value] of Object.entries(body)) expect([key, field(key)]).toEqual([key, typeof value === 'string' ? value : JSON.stringify(value)])
      expect(page.querySelector('[data-outward-field="why"]')).toBeNull()
      fireEvent.click(page.querySelector<HTMLButtonElement>('[data-outward-approve]')!)
      const outcome = await waitFor(() => {
        const said = page.querySelector('[data-outward-outcome="sent"], [data-outward-outcome="refused"]')
        expect(said).not.toBeNull()
        return said!
      })
      expect([outcome.getAttribute('data-outward-outcome'), outcome.textContent]).toEqual(['sent', 'Sent.'])
      const approved = canonicalJson(body)
      expect(run.record.bindings).toHaveLength(1)
      expect(run.record.bindings[0]).toMatchObject({ method: 'POST', pathname: '/_host/linear', bodySha256: sha256(approved) })
      expect(run.record.sends.map(send => [send.url, send.method, send.canonical])).toEqual([['/_host/linear', 'POST', approved]])
      expect(refused.filter(attempt => attempt.url.includes('/_host/linear') || attempt.url.includes('/_host/aumlok'))).toEqual([])
    })
  }
})
