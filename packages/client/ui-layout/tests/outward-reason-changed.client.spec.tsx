// @vitest-environment jsdom
/**
 * An ask the edge refused with `CLOUDFLARE_REASON_CHANGED` is never offered or sent
 * again. Checked at the approval itself, before the passkey (a card holding an earlier read still asks nothing); kept in
 * this browser's storage, so a reload or another tab knows it; and every card on the page is told at once. Everything
 * here is a made-up stand-in (tests/drive-fixture/outward.tsx): no passkey, Cloudflare or network is real.
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approveAndSendOutward, CLOUDFLARE_REASON_CHANGED_WORDS, parseStagedOutward, readStagedOutward, REASON_CHANGED_KEY, reasonChangedFor,
  resetReasonChangedForTests, type StagedOutward,
} from '../src/client/spatial/aumlok/outward-class3.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import { SENT_KEY } from '../src/client/spatial/aumlok/outward-sent.ts'
import { DriveFixture, prepareFixture, refuseNetwork } from './drive-fixture/fixture.tsx'
import { outwardRunOf, stagedFileOf, type OutwardRun } from './drive-fixture/outward.tsx'
import { fixtureWorld } from './drive-fixture/world.ts'

const ORIGIN = 'https://fixture.invalid'
const MODULE = '../src/client/spatial/aumlok/outward-class3.ts'
beforeEach(() => {
  refuseNetwork()
  localStorage.clear()
  vi.stubGlobal('innerWidth', 1440)
  vi.stubGlobal('matchMedia', (query: string) => ({ media: query, matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
})
afterEach(() => { cleanup(); resetReasonChangedForTests(); resetApprovalsForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Her staged file for a run, read as every card reads it. */
async function stagedOf(run: OutwardRun): Promise<StagedOutward> {
  const read = await run.reader.whole(run.sessionId, '/dsh/home/auma/staged/outward-class3.json', new AbortController().signal)
  if (!read.ok) throw new Error('fixture: no staged file')
  return parseStagedOutward(read.text)!
}
const refusal: typeof fetch = async () => Promise.resolve(Response.json(
  { ok: false, code: 'CLOUDFLARE_REASON_CHANGED', protection: 'open' }, { status: 409 }))

describe('the approval itself refuses an ask the edge already refused, before the passkey', () => {
  it('approving the same read twice after a 409 asks the passkey once and posts once', async () => {
    const run = outwardRunOf('cf-changed')!
    const staged = await stagedOf(run)
    const deps = { ...run.ceremony, signal: new AbortController().signal }
    const first = await approveAndSendOutward(staged, ORIGIN, deps, run.fetchImpl)
    expect(first).toMatchObject({ kind: 'refused', words: CLOUDFLARE_REASON_CHANGED_WORDS })
    // A card that read her file before the refusal (its read still fresh) taps approve with that same read.
    const second = await approveAndSendOutward(staged, ORIGIN, deps, run.fetchImpl)
    expect(second).toEqual({ kind: 'refused', words: CLOUDFLARE_REASON_CHANGED_WORDS, sent: null })
    expect(run.record.bindings).toHaveLength(1)
    expect(run.record.sends).toHaveLength(1)
  })
})

describe('the record outlives the page', () => {
  it('a reload (the module loaded afresh, as another tab loads it) still refuses it, before any passkey', async () => {
    const run = outwardRunOf('cf-changed')!
    const staged = await stagedOf(run)
    const signal = new AbortController().signal
    await approveAndSendOutward(staged, ORIGIN, { ...run.ceremony, signal }, run.fetchImpl)
    vi.resetModules()
    const reloaded = await import(MODULE) as typeof import('../src/client/spatial/aumlok/outward-class3.ts')
    const file = await run.reader.whole(run.sessionId, reloaded.STAGED_OUTWARD_PATH, signal) as { text: string }
    const again = reloaded.parseStagedOutward(file.text)!
    expect(reloaded.reasonChangedFor(again)).toBe(true)
    expect(await reloaded.readStagedOutward(run.reader, run.sessionId, signal)).toEqual({ kind: 'none' })
    expect(await reloaded.approveAndSendOutward(again, ORIGIN, { ...run.ceremony, signal }, run.fetchImpl))
      .toEqual({ kind: 'refused', words: CLOUDFLARE_REASON_CHANGED_WORDS, sent: null })
    expect(run.record.bindings).toHaveLength(1)
    // She asks again (a new staged file): offered, in the reloaded page too.
    const asked = { ...run.reader, whole: async () => ({ ok: true as const, text: stagedFileOf(run.ask, 1_762_940_000_001) }) }
    expect((await reloaded.readStagedOutward(asked, run.sessionId, signal)).kind).toBe('staged')
  })

  it('keeps the last 16 asks, small, under its own key; with storage refused the page still holds it', async () => {
    const run = outwardRunOf('cf-long')!
    const signal = new AbortController().signal
    for (let at = 1; at <= 17; at += 1) {
      const staged = parseStagedOutward(stagedFileOf(run.ask, at))!
      await approveAndSendOutward(staged, ORIGIN, { ...run.ceremony, signal }, refusal)
    }
    const kept = JSON.parse(localStorage.getItem(REASON_CHANGED_KEY) ?? 'null') as unknown
    expect(Array.isArray(kept) && kept.length).toBe(16)
    // A 60,000-character ask is kept as a short key, not its bytes.
    expect(localStorage.getItem(REASON_CHANGED_KEY)!.length).toBeLessThan(16 * 120)
    resetReasonChangedForTests()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('refused') })
    const staged = await stagedOf(run)
    await approveAndSendOutward(staged, ORIGIN, { ...run.ceremony, signal }, refusal)
    expect(localStorage.getItem(REASON_CHANGED_KEY)).toBeNull()
    expect(reasonChangedFor(staged)).toBe(true)
    expect(await readStagedOutward(run.reader, run.sessionId, signal)).toEqual({ kind: 'none' })
  })
})

describe('every card is told at once', () => {
  function mount(run: OutwardRun) {
    const world = fixtureWorld({ latencyMs: 0, now: new Date(2026, 10, 13, 18, 0).getTime() })
    vi.stubGlobal('__AUKORA_SUPERAGENT__', world.bridge)
    return render(<DriveFixture chat={false} world={world} outward={run} />).container
  }
  const offered = (page: HTMLElement): boolean => page.querySelector('[data-outward-approve]') !== null

  it('another card on this page gets the 409: this card stops offering the bytes, with no change to her file', async () => {
    const run = outwardRunOf('cf-dns')!
    const page = mount(run)
    await waitFor(() => { expect(offered(page)).toBe(true) })
    // The other card (the chat's) approves the same read through its own passkey stand-in (nothing this page's record
    // shows, so nothing re-renders this card), and the edge answers that its reason changed.
    const chat = outwardRunOf('cf-dns')!
    await approveAndSendOutward(await stagedOf(run), ORIGIN, { ...chat.ceremony, signal: new AbortController().signal }, refusal)
    expect(chat.record.bindings).toHaveLength(1)
    await waitFor(() => { expect(offered(page)).toBe(false) })
    expect(run.record.bindings).toHaveLength(0)
    expect(run.record.sends).toHaveLength(0)
  })

  it('another tab gets the 409: its `storage` event makes this card read again and stop offering', async () => {
    const run = outwardRunOf('cf-dns')!
    const page = mount(run)
    await waitFor(() => { expect(offered(page)).toBe(true) })
    // Another tab: its own copy of the module, sharing only this browser's storage.
    vi.resetModules()
    const other = await import(MODULE) as typeof import('../src/client/spatial/aumlok/outward-class3.ts')
    const staged = other.parseStagedOutward(stagedFileOf(run.ask))!
    await other.approveAndSendOutward(staged, ORIGIN, { ...outwardRunOf('cf-dns')!.ceremony, signal: new AbortController().signal }, refusal)
    expect(offered(page)).toBe(true)
    globalThis.dispatchEvent(new StorageEvent('storage', { key: REASON_CHANGED_KEY }))
    await waitFor(() => { expect(offered(page)).toBe(false) })
    other.resetReasonChangedForTests()
  })
})

describe('the fixture page', () => {
  it('each load of ?outward=<name> starts with no record of asks sent or refused, so a reload shows the card again', () => {
    localStorage.setItem(REASON_CHANGED_KEY, '["1:2:x"]')
    localStorage.setItem(SENT_KEY, '["{}"]')
    localStorage.setItem('aukora.other', 'kept')
    prepareFixture('?outward=cf-changed')
    expect([localStorage.getItem(REASON_CHANGED_KEY), localStorage.getItem(SENT_KEY), localStorage.getItem('aukora.other')])
      .toEqual([null, null, 'kept'])
  })
})
