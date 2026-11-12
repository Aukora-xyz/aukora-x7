// @vitest-environment jsdom
/**
 * Lane B3: the Staged Governance Pearl card's "View code diff" row (portal/CodeDiffRow.tsx), on the real Sovereignty
 * surface with the host stood in by `fetch` stubs. Every side is hash-checked wherever it was read; a side that was not
 * read is said; the row never changes the approve button; and the diff is computed once per pair of shas however often the
 * card is read again. The whole path against the real Worker and HEAD is in r29-edge-e2e.client.spec.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createHash } from 'node:crypto'
import { useLayoutEffect, useRef } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { parseStagedPromotion, STAGED_PROMOTION_PATH, verifiedModuleCode } from '../src/client/spatial/aumlok/head-promotion.ts'
import {
  CodeDiffRow, resetCodeDiffsForTests, type CodeDiffRowProps, type StagedPromotionCard,
} from '../src/client/spatial/portal/CodeDiffRow.tsx'
import { organCodeDiff } from '../src/client/spatial/portal/organ-code-diff.ts'
import { mergePromotionSources } from '../src/client/spatial/portal/promotion-sources.ts'
import {
  parsePublishedHead, promotionStateOf, SOVEREIGNTY_SURFACE, SovereigntySurface, type PromotionContext,
} from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import type { FileRead } from '../src/client/spatial/work/WorkSurface.tsx'

// The real diff, counted: a card read again must never compute it again for the same pair of shas.
vi.mock('../src/client/spatial/portal/organ-code-diff.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/spatial/portal/organ-code-diff.ts')>()
  return { ...actual, organCodeDiff: vi.fn(actual.organCodeDiff) }
})
const diffCalls = vi.mocked(organCodeDiff)
// The row's own hash checks, counted (only the row calls it): a card read again must not check the same pair again.
vi.mock('../src/client/spatial/aumlok/head-promotion.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/spatial/aumlok/head-promotion.ts')>()
  return { ...actual, verifiedModuleCode: vi.fn(actual.verifiedModuleCode) }
})
const rowHashChecks = vi.mocked(verifiedModuleCode)
// The surface's read of the card, as it hands the card over (its next step is `setPromotion`): a quiet re-read is awaited
// to there, never guessed with a sleep.
vi.mock('../src/client/spatial/portal/promotion-sources.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/spatial/portal/promotion-sources.ts')>()
  return { ...actual, mergePromotionSources: vi.fn(actual.mergePromotionSources) }
})
const merges = vi.mocked(mergePromotionSources)

class FakeChannel { onmessage = null; close() {} }
class FakeSocket {
  static open: FakeSocket[] = []
  onopen = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose = null
  closed = false
  constructor() { FakeSocket.open.push(this) }
  close() { this.closed = true }
}
/** A live message from the host, as its socket pushes it. */
const push = (message: unknown) => {
  for (const socket of FakeSocket.open.filter(s => !s.closed)) socket.onmessage?.({ data: JSON.stringify(message) })
}
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
  resetCodeDiffsForTests()
  diffCalls.mockClear()
  rowHashChecks.mockClear()
  merges.mockClear()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

// ── A real manifest in HEAD's own shape, with real module bytes (as sovereignty-r24.client.spec.tsx builds them) ────────
const codeOf = (name: string, version: number) => `export default { organ: ${JSON.stringify(name)}, version: ${String(version)} }\n`
const entryOf = (id: string, code: string, config: Record<string, unknown> = {}) => ({ id, specifier: `ball:${sha(code)}`, disabled: false,
  config, previousSpecifiers: [] as string[] })
interface BallContents {
  readonly parentBallId: string | null
  readonly epoch: number
  readonly entries: Record<string, unknown>
  readonly modules: Record<string, unknown>
}
const manifestIdOf = (ball: BallContents) => sha(JSON.stringify({ version: 'x6.1-ball/v1', parentBallId: ball.parentBallId, epoch: ball.epoch,
  entries: Object.keys(ball.entries).sort().map(key => ball.entries[key]),
  modules: Object.keys(ball.modules).sort().map(key => ball.modules[key]) }))
type Configs = Record<string, Record<string, unknown>>
const ballOf = (parentBallId: string | null, epoch: number, codes: Record<string, string>, configs: Configs = {}) => {
  const entries = Object.fromEntries(Object.entries(codes).map(([id, code]) => [id, entryOf(id, code, configs[id])]))
  const modules = Object.fromEntries(Object.values(codes).map(code => [sha(code), { sha256: sha(code), specifier: `ball:${sha(code)}` }]))
  const contents = { version: 'x6.1-ball/v1', parentBallId, epoch, authorPeerId: 'peer-1', entries, modules }
  return { ...contents, ballId: manifestIdOf(contents) }
}
const PEARL_62 = codeOf('seed-pearl', 62)
const PEARL_63 = codeOf('seed-pearl', 63)
const NOTES = codeOf('auma-notes', 1)
const GENESIS = ballOf(null, 0, { 'seed-pearl': PEARL_62, 'auma-notes': NOTES })
type Ball = ReturnType<typeof ballOf>
/** Her staged file for a Pearl on top of the head given (GENESIS unless said), carrying the code given. */
const stagedFile = (ball: { readonly ballId: string }, codeBySha: Record<string, string>, parent: Ball = GENESIS) => JSON.stringify({
  schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 11, 9), body: {
    ball, codeBySha, expectedParentBallId: parent.ballId, expectedEpoch: 0, writerLease: { ownerPeerId: 'peer-1', generation: 1 } } })
const NEXT = ballOf(GENESIS.ballId, 1, { 'seed-pearl': PEARL_63, 'auma-notes': NOTES })
const STAGED = stagedFile(NEXT, { [sha(PEARL_63)]: PEARL_63 })
const homeBall = (code: string) => `/dsh/home/balls/${sha(code)}.js`

/** The host, stood in: bound passkey, the edge, a free lease, and `/_head/ball` serving a head (GENESIS) with the code given. */
const hostWith = (served: Record<string, unknown>, published: Ball = GENESIS) => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${input}`)
    if (input === '/_host/aumlok/status') {
      return json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] })
    }
    if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
    if (input === '/_head/lease') return json({ ok: true, lease: null, ballId: published.ballId, epoch: 0, governancePromotion: true })
    if (input === '/_head/ball') {
      return json({ ok: true, buildSha: 'b'.repeat(40), head: { ballId: published.ballId, parentBallId: null, epoch: 0, entries: published.entries },
        peers: [], ...served })
    }
    return new Response('nope', { status: 404 })
  }))
  return { headReads: () => calls.filter(call => call === 'GET /_head/ball').length,
    leaseReads: () => calls.filter(call => call === 'GET /_head/lease').length }
}
/** The surface, with her home holding the staged file (read each time) and any module files given. */
const mount = (staged: () => string, home: Record<string, string> = {}) => {
  const reads: string[] = []
  const list = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } },
    phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  const props = {
    activeSurface: SOVEREIGNTY_SURFACE,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => {
      reads.push(path)
      if (path === STAGED_PROMOTION_PATH) return { ok: true, text: staged() }
      const text = Object.hasOwn(home, path) ? home[path] : undefined
      return text === undefined ? { ok: false, reason: 'not-found' } : { ok: true, text }
    } },
  } as unknown as Parameters<typeof SovereigntySurface>[0]
  const view = render(<SovereigntySurface {...props} />)
  const card = () => view.container.querySelector('[data-sovereignty-portal="promotion"]')
  const hook = () => view.container.querySelector('[data-sovereignty-code-diff]')
  const state = () => hook()?.getAttribute('data-sovereignty-code-diff')
  const body = () => view.container.querySelector('[data-sovereignty-code-diff-body]')
  const approve = () => view.container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
  /** Open the row as the owner opens it (a click on an open row would close it). */
  const openDiff = () => {
    const head = hook()?.closest('button')
    if (head instanceof HTMLButtonElement && head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head)
  }
  return { ...view, reads, card, hook, state, body, approve, openDiff }
}

/**
 * Every state the row's hook took while watched: each value it changed from or to, and the state of each row put in or
 * taken out (a row that goes to reading loses its body, so it can be redrawn rather than changed in place).
 */
const watchRowStates = (root: Element) => {
  const seen = new Set<string>()
  const note = (node: Node): void => {
    if (!(node instanceof Element)) return
    for (const hook of [node, ...node.querySelectorAll('[data-sovereignty-code-diff]')]) {
      const state = hook.getAttribute('data-sovereignty-code-diff')
      if (state !== null) seen.add(state)
    }
  }
  const take = (records: readonly MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === 'attributes' && record.oldValue !== null) seen.add(record.oldValue)
      note(record.target)
      record.addedNodes.forEach(note)
      record.removedNodes.forEach(note)
    }
  }
  const observer = new MutationObserver(take)
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
    attributeFilter: ['data-sovereignty-code-diff'] })
  return { stop: (): string[] => { take(observer.takeRecords()); observer.disconnect(); return [...seen] } }
}

/** What the row shows, as the owner sees it: its state, its counts, its line, and (opened) its sources and hunks. */
const shownIn = (root: ParentNode | null) => {
  const hook = root?.querySelector('[data-sovereignty-code-diff]') ?? null
  return {
    state: hook?.getAttribute('data-sovereignty-code-diff') ?? null,
    added: hook?.getAttribute('data-code-diff-added') ?? null,
    removed: hook?.getAttribute('data-code-diff-removed') ?? null,
    words: hook?.textContent ?? null,
    sources: root?.querySelector('[data-code-diff-sources]')?.textContent ?? null,
    body: root?.querySelector('[data-sovereignty-code-diff-body]')?.textContent ?? null,
  }
}

describe('Lane B3: the staged card\'s "View code diff" row', () => {
  it('the published Pearl serves the code it runs now: "+1 / −1 lines", closed; opened, 62 removed and 63 added, sources said', async () => {
    const host = hostWith({ codeBySha: { [sha(PEARL_62)]: PEARL_62, [sha(NOTES)]: NOTES } })
    const page = mount(() => STAGED)
    await waitFor(() => { expect(page.state()).toBe('ok') }, { timeout: 10_000 })
    expect(page.hook()?.getAttribute('data-code-diff-added')).toBe('1')
    expect(page.hook()?.getAttribute('data-code-diff-removed')).toBe('1')
    expect(page.hook()?.textContent).toBe('+1 / −1 lines')
    expect(page.hook()?.closest('li')?.textContent).toContain('View code diff')
    // CLOSED BY DEFAULT: the summary is the visible part; the hunks are built only when it is opened.
    expect(page.body()).toBeNull()
    // Between the approve button (and its line) and the card's rows; the button itself is untouched.
    const approve = page.approve()
    expect(approve?.disabled).toBe(false)
    const row = page.hook()
    const rows = page.card()?.querySelector('dl.ak-fields')
    if (approve === null || row === null || rows === null || rows === undefined) throw new Error('the card is missing a part')
    expect(approve.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    page.openDiff()
    await waitFor(() => { expect(page.body()).not.toBeNull() })
    expect(page.body()?.querySelector('.ak-diff__hunk')?.textContent).toBe('@@ -1,1 +1,1 @@')
    expect(page.body()?.querySelector('.ak-diff__del')?.textContent).toContain('version: 62')
    expect(page.body()?.querySelector('.ak-diff__add')?.textContent).toContain('version: 63')
    const sources = page.container.querySelector('[data-code-diff-sources]')?.textContent
    expect(sources).toContain(`the code it runs now: from the published Pearl (ball:${sha(PEARL_62).slice(0, 12)}…)`)
    expect(sources).toContain(`the new code: from the staged Pearl (ball:${sha(PEARL_63).slice(0, 12)}…)`)
    expect(sources).toContain('every byte shown is hash-checked here')
    // NO REQUEST OF ITS OWN: the one `/_head/ball` read of this opening serves the row, and her home is not read for code.
    expect(host.headReads()).toBe(1)
    expect(page.reads.filter(path => path.startsWith('/dsh/home/balls/'))).toEqual([])
    expect(diffCalls).toHaveBeenCalledTimes(1)
    expect(diffCalls).toHaveBeenCalledWith(PEARL_62, PEARL_63)
  }, 30_000)

  it('the published Pearl serves no code: the row says the code it runs now was not read; the approve button is unchanged', async () => {
    hostWith({ modules: {} })
    const page = mount(() => STAGED)
    await waitFor(() => { expect(page.state()).toBe('unread') }, { timeout: 10_000 })
    expect(page.hook()?.textContent).toBe(`the code it runs now was not read (the published Pearl did not serve ball:${sha(PEARL_62).slice(0, 12)}… `
      + 'with that hash, nor did her home)')
    expect(page.hook()?.hasAttribute('data-code-diff-added')).toBe(false)
    // A static row: nothing to open, nothing drawn as empty.
    expect(page.hook()?.closest('button')).toBeNull()
    expect(page.body()).toBeNull()
    expect(page.approve()?.disabled).toBe(false)
    expect(page.reads).toContain(homeBall(PEARL_62))
    expect(diffCalls).not.toHaveBeenCalled()
  }, 30_000)

  it('a copy the published Pearl serves that does not hash is never shown; her home\'s copy that does is, and is named', async () => {
    // The Mac host serves its mirror's files without checking them.
    hostWith({ codeBySha: { [sha(PEARL_62)]: 'export default { tampered: true }\n' } })
    const page = mount(() => STAGED, { [homeBall(PEARL_62)]: PEARL_62 })
    await waitFor(() => { expect(page.state()).toBe('ok') }, { timeout: 10_000 })
    page.openDiff()
    await waitFor(() => { expect(page.body()).not.toBeNull() })
    expect(page.body()?.textContent).not.toContain('tampered')
    expect(page.body()?.querySelector('.ak-diff__del')?.textContent).toContain('version: 62')
    expect(page.container.querySelector('[data-code-diff-sources]')?.textContent).toContain('the code it runs now: from her home (ball:')
  }, 30_000)

  it('a home copy that does not hash is not used either: the code it runs now is said as not read', async () => {
    hostWith({ codeBySha: {} })
    const page = mount(() => STAGED, { [homeBall(PEARL_62)]: 'export default { tampered: true }\n' })
    await waitFor(() => { expect(page.state()).toBe('unread') }, { timeout: 10_000 })
    expect(page.hook()?.textContent).toContain('the code it runs now was not read')
    expect(diffCalls).not.toHaveBeenCalled()
  }, 30_000)

  it('staged bytes that do not hash to their id: the mismatch is said, and no diff is drawn', async () => {
    hostWith({ codeBySha: { [sha(PEARL_62)]: PEARL_62 } })
    const page = mount(() => stagedFile(NEXT, { [sha(PEARL_63)]: 'export default { organ: "seed-pearl", version: 999 }\n' }))
    await waitFor(() => { expect(page.state()).toBe('mismatch') }, { timeout: 10_000 })
    expect(page.card()?.textContent).toContain('CANNOT LAND')
    expect(page.hook()?.textContent).toBe(`the staged bytes do not hash to ball:${sha(PEARL_63).slice(0, 12)}…, so no diff is shown`)
    expect(page.hook()?.closest('button')).toBeNull()
    expect(page.container.textContent).not.toContain('version: 999')
    expect(diffCalls).not.toHaveBeenCalled()
  }, 30_000)

  it('a change that keeps the code (its config only) draws no code diff row at all', async () => {
    hostWith({ codeBySha: { [sha(PEARL_62)]: PEARL_62 } })
    const configured = ballOf(GENESIS.ballId, 1, { 'seed-pearl': PEARL_62, 'auma-notes': NOTES }, { 'seed-pearl': { mode: 'strict' } })
    const page = mount(() => stagedFile(configured, {}))
    await waitFor(() => { expect(page.card()?.textContent).toContain('CLASS 3') }, { timeout: 10_000 })
    expect(page.card()?.textContent).toContain('seed-pearl')
    expect(page.hook()).toBeNull()
  }, 30_000)

  it('a removed organ is all removed, and a new organ all added: the side that has no code is said as none', async () => {
    hostWith({ codeBySha: { [sha(PEARL_62)]: PEARL_62, [sha(NOTES)]: NOTES } })
    const removed = mount(() => stagedFile(ballOf(GENESIS.ballId, 1, { 'auma-notes': NOTES }), {}))
    await waitFor(() => { expect(removed.state()).toBe('ok') }, { timeout: 10_000 })
    expect(removed.hook()?.textContent).toBe('+0 / −1 lines')
    removed.openDiff()
    await waitFor(() => { expect(removed.body()).not.toBeNull() })
    expect(removed.body()?.querySelector('.ak-diff__hunk')?.textContent).toBe('@@ -1,1 +0,0 @@')
    expect(removed.container.querySelector('[data-code-diff-sources]')?.textContent).toContain('the new code: none (the organ is removed)')
    cleanup()
    const code = 'export default {\n  organ: "seed-continuity",\n  version: 1,\n}\n'
    const withNew = ballOf(GENESIS.ballId, 1, { 'seed-pearl': PEARL_62, 'auma-notes': NOTES, 'seed-continuity': code },
      { 'seed-continuity': { governance: true } })
    const added = mount(() => stagedFile(withNew, { [sha(code)]: code }))
    await waitFor(() => { expect(added.state()).toBe('ok') }, { timeout: 10_000 })
    expect(added.hook()?.textContent).toBe('+4 / −0 lines')
    added.openDiff()
    await waitFor(() => { expect(added.body()).not.toBeNull() })
    expect(added.container.querySelector('[data-code-diff-sources]')?.textContent).toContain('the code it runs now: none (a new organ)')
    expect(added.container.querySelector('[data-code-diff-sources]')?.textContent).toContain('the new code: from the staged Pearl')
  }, 30_000)

  it('past the caps the row says so: one block with "at most" counts, rows past 500 counted, a side over 512 KiB not compared', async () => {
    const lines = (label: string) => Array.from({ length: 2_100 }, (_, index) => `// ${label} ${String(index)}\n`).join('')
    const oldCode = `export default {}\n${lines('old')}`
    const big = ballOf(null, 0, { 'seed-pearl': oldCode, 'auma-notes': NOTES })
    const newCode = `export default {}\n${lines('new')}`
    hostWith({ codeBySha: { [sha(oldCode)]: oldCode } }, big)
    const block = mount(() => stagedFile(ballOf(big.ballId, 1, { 'seed-pearl': newCode, 'auma-notes': NOTES }), { [sha(newCode)]: newCode }, big))
    await waitFor(() => { expect(block.state()).toBe('block') }, { timeout: 10_000 })
    expect(block.hook()?.textContent).toBe('at most +2100 / −2100 lines (too many changed lines to compare one by one here)')
    expect([block.hook()?.getAttribute('data-code-diff-added'), block.hook()?.getAttribute('data-code-diff-removed')]).toEqual(['2100', '2100'])
    block.openDiff()
    await waitFor(() => { expect(block.body()).not.toBeNull() })
    expect(block.body()?.querySelectorAll('.ak-diff__row')).toHaveLength(500)
    expect(block.body()?.querySelector('.ak-diff__hunk')?.textContent).toBe('@@ -1,2101 +1,2101 @@')
    expect(block.card()?.textContent).toContain('Too many lines changed to compare them one by one here')
    expect(block.card()?.textContent).toContain('3702 more rows of this diff are not shown here; the counts above are for the whole change.')
    cleanup()
    // A side over 512 KiB is read (her staged Pearl carries it) and checked, but never split or compared.
    const huge = `export default "${'x'.repeat(600 * 1024)}"\n`
    hostWith({ codeBySha: { [sha(PEARL_62)]: PEARL_62 } })
    const tooLarge = mount(() => stagedFile(ballOf(GENESIS.ballId, 1, { 'seed-pearl': huge, 'auma-notes': NOTES }), { [sha(huge)]: huge }))
    await waitFor(() => { expect(tooLarge.state()).toBe('too-large') }, { timeout: 10_000 })
    expect(tooLarge.hook()?.textContent).toBe('too large to compare here (52 B → 600.0 KiB; this page compares up to 512.0 KiB a side)')
    expect(tooLarge.hook()?.closest('button')).toBeNull()
    cleanup()
    // Her home's file over the cap is not even hashed: it is not called the module.
    hostWith({ codeBySha: {} })
    const home = mount(() => STAGED, { [homeBall(PEARL_62)]: 'y'.repeat(600 * 1024) })
    await waitFor(() => { expect(home.state()).toBe('too-large') }, { timeout: 10_000 })
    expect(home.hook()?.textContent).toBe(`too large to compare here: her home's file for ball:${sha(PEARL_62).slice(0, 12)}… (the code it runs now) `
      + 'is over 512 KiB, so it was not checked')
  }, 30_000)

  it('quiet re-reads and Refresh never compute the diff again for the same shas; a restaged Pearl is compared anew', async () => {
    const host = hostWith({ codeBySha: { [sha(PEARL_62)]: PEARL_62, [sha(NOTES)]: NOTES } })
    let onDisk = STAGED
    const page = mount(() => onDisk)
    await waitFor(() => { expect(page.state()).toBe('ok') }, { timeout: 10_000 })
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    const stagedReads = () => page.reads.filter(path => path === STAGED_PROMOTION_PATH).length
    // The counter sees the row's own checks: both sides of the pair were hash-checked once to draw the row.
    expect(rowHashChecks.mock.calls.map(([, checked]) => checked)).toEqual(expect.arrayContaining([sha(PEARL_62), sha(PEARL_63)]))
    // A live change to her staged file reads the card again, quietly: the row stays as it is. It never goes back to
    // reading, and neither side is hash-checked again (the row's read is keyed on strings, never on the card object).
    const before = stagedReads()
    const leasesBefore = host.leaseReads()
    const mergesBefore = merges.mock.calls.length
    const checksBefore = rowHashChecks.mock.calls.length
    const watch = watchRowStates(page.container)
    push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] })
    await waitFor(() => { expect(stagedReads()).toBeGreaterThan(before) }, { timeout: 10_000 })
    await waitFor(() => { expect(host.leaseReads()).toBeGreaterThan(leasesBefore) }, { timeout: 10_000 })
    // SETTLED, NOT SLEPT ON: the re-read handed its new card object to the surface, and React rendered it and ran every
    // effect that followed (act flushes them all before it returns).
    await waitFor(() => { expect(merges.mock.calls.length).toBeGreaterThan(mergesBefore) }, { timeout: 10_000 })
    await act(async () => { await merges.mock.results.at(-1)?.value })
    expect(watch.stop().filter(state => state !== 'ok')).toEqual([])
    expect(rowHashChecks.mock.calls.slice(checksBefore)).toEqual([])
    expect(page.state()).toBe('ok')
    expect(diffCalls).toHaveBeenCalledTimes(1)
    // Refresh reads everything again (the card goes to reading and back): the kept diff is used.
    fireEvent.click(page.container.querySelector('[data-sovereignty-refresh]') as Element)
    await waitFor(() => { expect(host.headReads()).toBe(2) }, { timeout: 10_000 })
    await waitFor(() => { expect(page.state()).toBe('ok') }, { timeout: 10_000 })
    expect(diffCalls).toHaveBeenCalledTimes(1)
    // Auma stages another Pearl in its place: the row follows the Pearl on the card.
    const pearl6300 = codeOf('seed-pearl', 6300)
    onDisk = stagedFile(ballOf(GENESIS.ballId, 1, { 'seed-pearl': pearl6300, 'auma-notes': NOTES }), { [sha(pearl6300)]: pearl6300 })
    push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] })
    await waitFor(() => { expect(diffCalls).toHaveBeenCalledTimes(2) }, { timeout: 10_000 })
    await waitFor(() => { expect(page.state()).toBe('ok') }, { timeout: 10_000 })
    page.openDiff()
    await waitFor(() => { expect(page.body()?.querySelector('.ak-diff__add')?.textContent).toContain('version: 6300') })
    expect(diffCalls).toHaveBeenLastCalledWith(PEARL_62, pearl6300)
  }, 30_000)
})

describe('Lane B3: the row follows the pair of shas it is given', () => {
  it('a new Pearl on the row says reading from its very first render: the last Pearl\'s diff is never shown under it', async () => {
    const context: PromotionContext = { published: { entries: GENESIS.entries, ballId: GENESIS.ballId, epoch: 0 }, lease: null,
      canQualify: true, runtime: 'cloudflare', audience: 'http://localhost:3000', now: 1, leaseUnread: null }
    const cardOf = async (file: string): Promise<StagedPromotionCard> => {
      const state = await promotionStateOf(parseStagedPromotion(file), context)
      if (state.kind !== 'staged') throw new Error(`expected a staged card, not ${state.kind}`)
      return state
    }
    const pearl64 = codeOf('seed-pearl', 64)
    const pearlA = await cardOf(STAGED)
    // Pearl B's new code is in neither Pearl, so it is read from her home, and that read is held until the test answers it.
    const pearlB = await cardOf(stagedFile(ballOf(GENESIS.ballId, 1, { 'seed-pearl': pearl64, 'auma-notes': NOTES }), {}))
    let answer: (read: FileRead) => void = () => {}
    const held = new Promise<FileRead>((resolve) => { answer = resolve })
    const reads: string[] = []
    const reader: CodeDiffRowProps['reader'] = { whole: async (_session, path) => {
      reads.push(path)
      return path === homeBall(pearl64) ? held : { ok: false, reason: 'not-found' }
    } }
    const published = { [sha(PEARL_62)]: PEARL_62 }
    const commits: { readonly card: StagedPromotionCard; readonly shown: ReturnType<typeof shownIn> }[] = []
    function Probe({ card }: { readonly card: StagedPromotionCard }) {
      const box = useRef<HTMLDivElement>(null)
      // A LAYOUT EFFECT runs once a commit's DOM is written and before the row's own (passive) effect runs: what it notes is
      // what the first commit with this card put on screen, which act() would otherwise hide.
      useLayoutEffect(() => { commits.push({ card, shown: shownIn(box.current) }) }, [card])
      return (
        <div ref={box}>
          <CodeDiffRow promotion={card} published={published} reader={reader} sessionId={'s1' as CodeDiffRowProps['sessionId']} />
        </div>
      )
    }
    const page = render(<Probe card={pearlA} />)
    await waitFor(() => { expect(shownIn(page.container).state).toBe('ok') }, { timeout: 10_000 })
    // Opened on Pearl A (62 → 63).
    fireEvent.click(page.container.querySelector('[data-sovereignty-code-diff]')?.closest('button') as Element)
    expect(shownIn(page.container)).toMatchObject({ added: '1', removed: '1', words: '+1 / −1 lines' })
    expect(shownIn(page.container).body).toContain('version: 63')
    // Auma restages: Pearl B (62 → 64) comes onto the same row.
    commits.length = 0
    page.rerender(<Probe card={pearlB} />)
    const reading = { state: 'reading', added: null, removed: null, words: 'Reading the code…', sources: null, body: null }
    // ITS VERY FIRST COMMIT already says reading: no count, line, hook, source or hunk of Pearl A under Pearl B.
    expect(commits).toHaveLength(1)
    expect(commits[0]?.card).toBe(pearlB)
    expect(commits[0]?.shown).toEqual(reading)
    // And so it is right after the rerender, before anything is awaited.
    expect(shownIn(page.container)).toEqual(reading)
    // Her home is asked for Pearl B's new code; until it answers, the row still says reading.
    await waitFor(() => { expect(reads).toContain(homeBall(pearl64)) })
    expect(shownIn(page.container)).toEqual(reading)
    answer({ ok: true, text: pearl64 })
    await waitFor(() => { expect(shownIn(page.container).state).toBe('ok') }, { timeout: 10_000 })
    const shown = shownIn(page.container)
    expect(shown).toMatchObject({ added: '1', removed: '1', words: '+1 / −1 lines' })
    expect(shown.body).toContain('version: 64')
    expect(shown.body).not.toContain('version: 63')
    expect(shown.sources).toContain(`the new code: from her home (ball:${sha(pearl64).slice(0, 12)}…)`)
    expect(diffCalls).toHaveBeenLastCalledWith(PEARL_62, pearl64)
  }, 30_000)
})

describe('Lane B3: what the card carries for the diff', () => {
  it('the published head keeps the code by sha it is served (strings under 64-hex keys only), else its modules', () => {
    const good = 'a'.repeat(64)
    const parsed = parsePublishedHead({ ok: true, head: { ballId: GENESIS.ballId, epoch: 0 }, modules: { [good]: 'm' },
      codeBySha: { [good]: 'code', short: 'no', ['b'.repeat(64)]: 42, ['C'.repeat(64)]: 'upper' } })
    expect(parsed?.codeBySha).toEqual({ [good]: 'code' })
    expect(parsed?.modules).toBe(1)
    expect(parsePublishedHead({ ok: true, head: { ballId: GENESIS.ballId }, modules: { [good]: 'm' } })?.codeBySha).toEqual({ [good]: 'm' })
    expect(parsePublishedHead({ ok: true, head: { ballId: GENESIS.ballId } })?.codeBySha).toBeNull()
  })

  it('a staged card names the entry, the change, and the module on each side (the binding\'s own sha for the new code)', async () => {
    const context: PromotionContext = { published: { entries: GENESIS.entries, ballId: GENESIS.ballId, epoch: 0 }, lease: null,
      canQualify: true, runtime: 'cloudflare', audience: 'http://localhost:3000', now: 1, leaseUnread: null }
    const staged = parseStagedPromotion(STAGED)
    const state = await promotionStateOf(staged, context)
    expect(state).toMatchObject({ kind: 'staged', entryId: 'seed-pearl', organChange: 'changed', incumbentSha: sha(PEARL_62),
      candidateSha: sha(PEARL_63), binding: { candidateSha256: sha(PEARL_63) } })
    const removed = await promotionStateOf(parseStagedPromotion(stagedFile(ballOf(GENESIS.ballId, 1, { 'auma-notes': NOTES }), {})), context)
    expect(removed).toMatchObject({ kind: 'staged', organChange: 'removed', incumbentSha: sha(PEARL_62), candidateSha: null, bytes: 'not-code' })
  })
})
