// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * "VIEW CODE DIFF" ON THE STAGED GOVERNANCE PEARL CARD (Lane B3): the code the organ runs now beside the code the staged
 * Pearl would run, in one closed row whose line says "+X / −Y lines". DISPLAY ONLY: it never changes the approve button,
 * the terms Touch ID approves, or the card itself (Round 35: nothing replaces the card during an approval); its state is
 * its own.
 *
 * EVERY BYTE SHOWN IS HASH-CHECKED HERE against the `ball:<sha>` it is said to be, wherever it was read:
 *   the code it runs now  the published Pearl's code map (the `/_head/ball` answer the surface already read: no request of
 *                         its own), else her home's copy (/dsh/home/balls/<sha>.js); a new organ is compared with nothing
 *   the new code          the staged Pearl's own code map (her file's, or the compact one HEAD holds), else the published
 *                         Pearl's (a Pearl that goes back to code the head already holds: HEAD leaves that out of its compact
 *                         map), else her home's copy; a removed organ is compared with nothing
 * Staged bytes that do not hash to their id are said, and no diff is drawn. A side that was not read is said, never drawn
 * as empty. The diff is computed once per pair of shas (both content-addressed, so a kept one is never stale), however
 * often the card is read again.
 * @module portal/CodeDiffRow
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { verifiedModuleCode } from '../aumlok/head-promotion.ts'
import { Lead, RecordList, RecordRow } from '../primitives/index.ts'
import type { WorkReader } from '../work/WorkSurface.tsx'
import {
  CODE_DIFF_MAX_SIDE_BYTES, codeDiffRows, codeDiffSummary, organCodeDiff, utf8Length, type OrganCodeDiff,
} from './organ-code-diff.ts'
import type { PromotionState } from './SovereigntySurface.tsx'

/** The staged card the row belongs to. */
export type StagedPromotionCard = Extract<PromotionState, { kind: 'staged' }>

export interface CodeDiffRowProps {
  readonly promotion: StagedPromotionCard
  /** The published Pearl's code by sha, as the surface read it with `/_head/ball` (not checked yet; null when none). */
  readonly published: Readonly<Record<string, string>> | null
  readonly reader: WorkReader
  readonly sessionId: SessionId | undefined
}

/** Where one side's code was read. */
type CodeSource = 'published' | 'staged' | 'home'

/** One side, as read. */
type SideRead =
  | { readonly kind: 'code'; readonly text: string; readonly from: CodeSource | 'none' }
  | { readonly kind: 'unread'; readonly why: string }
  /** Her home's copy is over the side cap: neither hashed nor compared. */
  | { readonly kind: 'over' }
  | { readonly kind: 'mismatch' }

/** What the row shows. */
export type CodeDiffView =
  | { readonly kind: 'reading' }
  | { readonly kind: 'unread'; readonly why: string }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'home-too-large'; readonly side: 'now' | 'new' }
  | { readonly kind: 'diff'; readonly diff: OrganCodeDiff; readonly before: CodeSource | 'none'; readonly after: CodeSource | 'none' }

/** The row's state, as its `data-sovereignty-code-diff` hook says it. */
export type CodeDiffState = 'reading' | 'ok' | 'block' | 'too-large' | 'unread' | 'mismatch'

const READING: CodeDiffView = { kind: 'reading' }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const short = (sha: string): string => `ball:${sha.slice(0, 12)}…`

/** Diffs already computed, by `incumbent:candidate` sha. A few are kept: a card shows one Pearl at a time. */
const DIFFS = new Map<string, OrganCodeDiff>()
const DIFFS_KEPT = 16
const diffOf = (pair: string, before: string, after: string): OrganCodeDiff => {
  const kept = DIFFS.get(pair)
  if (kept !== undefined) return kept
  const diff = organCodeDiff(before, after)
  DIFFS.set(pair, diff)
  if (DIFFS.size > DIFFS_KEPT) {
    const oldest = DIFFS.keys().next()
    if (!oldest.done) DIFFS.delete(oldest.value)
  }
  return diff
}

/** Tests only: forget every diff computed on this page. */
export function resetCodeDiffsForTests(): void {
  DIFFS.clear()
}

/** The staged body's code by sha, read in the order `moduleBytes` reads it (`codeBySha`, else `modules`). */
const stagedCodeOf = (body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null =>
  (isRecord(body.codeBySha) ? body.codeBySha : isRecord(body.modules) ? body.modules : null)

/**
 * Her home's copy of a module (her loader writes each module it adopts there), only when it hashes to the sha. The reader
 * reads a file whole, so a copy over the side cap is read, but never hashed or compared.
 */
async function fromHome(reader: WorkReader, sessionId: SessionId | undefined, sha: string, signal: AbortSignal): Promise<SideRead | null> {
  if (sessionId === undefined) return null
  const file = await reader.whole(sessionId, `/dsh/home/balls/${sha}.js`, signal).catch(() => null)
  if (file === null || !file.ok) return null
  if (file.text.length > CODE_DIFF_MAX_SIDE_BYTES || utf8Length(file.text) > CODE_DIFF_MAX_SIDE_BYTES) return { kind: 'over' }
  const code = await verifiedModuleCode({ [sha]: file.text }, sha)
  return code === null ? null : { kind: 'code', text: code, from: 'home' }
}

/** What the row reads with: the card, the published code map, and her home. */
interface CodeDiffInput {
  readonly promotion: StagedPromotionCard
  readonly published: Readonly<Record<string, string>> | null
  readonly reader: WorkReader
  readonly sessionId: SessionId | undefined
}

/** The code it runs now: the published Pearl's, else her home's; nothing for a new organ. */
async function codeNow(input: CodeDiffInput, signal: AbortSignal): Promise<SideRead> {
  const card = input.promotion
  if (card.organChange === 'added') return { kind: 'code', text: '', from: 'none' }
  const sha = card.incumbentSha
  if (sha === null) return { kind: 'unread', why: 'the code it runs now is not a ball: module, so there is no code to compare' }
  const served = await verifiedModuleCode(input.published, sha)
  if (served !== null) return { kind: 'code', text: served, from: 'published' }
  return await fromHome(input.reader, input.sessionId, sha, signal) ?? { kind: 'unread',
    why: `the code it runs now was not read (the published Pearl did not serve ${short(sha)} with that hash, nor did her home)` }
}

/** The new code: the staged Pearl's, else the published Pearl's, else her home's; nothing for a removed organ. */
async function codeNew(input: CodeDiffInput, signal: AbortSignal): Promise<SideRead> {
  const card = input.promotion
  if (card.organChange === 'removed') return { kind: 'code', text: '', from: 'none' }
  const sha = card.candidateSha
  if (sha === null) return { kind: 'unread', why: 'the new entry is not a ball: module, so there is no code to compare' }
  // THE STAGED BYTES ARE NOT THEIR ID: said, and nothing else is shown in their place.
  if (card.bytes === 'mismatch') return { kind: 'mismatch' }
  const staged = await verifiedModuleCode(stagedCodeOf(card.staged.body), sha)
  if (staged !== null) return { kind: 'code', text: staged, from: 'staged' }
  const served = await verifiedModuleCode(input.published, sha)
  if (served !== null) return { kind: 'code', text: served, from: 'published' }
  return await fromHome(input.reader, input.sessionId, sha, signal) ?? { kind: 'unread',
    why: `the new code was not read (neither the staged Pearl nor the published Pearl carried ${short(sha)} with that hash, nor did her home)` }
}

/**
 * Read both sides and compare them.
 * @param input - the card, the published code map, the reader and the Session whose home it reads.
 * @param signal - aborts the home reads.
 * @returns what the row shows.
 */
export async function readCodeDiff(input: CodeDiffInput, signal: AbortSignal): Promise<CodeDiffView> {
  const [before, after] = await Promise.all([codeNow(input, signal), codeNew(input, signal)])
  if (after.kind === 'mismatch') return { kind: 'mismatch' }
  const unread = [before, after].flatMap(side => (side.kind === 'unread' ? [side.why] : []))
  if (unread.length > 0) return { kind: 'unread', why: unread.join('; ') }
  if (before.kind === 'over') return { kind: 'home-too-large', side: 'now' }
  if (after.kind === 'over') return { kind: 'home-too-large', side: 'new' }
  if (before.kind !== 'code' || after.kind !== 'code') return { kind: 'unread', why: 'the code was not read' }
  const pair = `${input.promotion.incumbentSha ?? 'none'}:${input.promotion.candidateSha ?? 'none'}`
  return { kind: 'diff', diff: diffOf(pair, before.text, after.text), before: before.from, after: after.from }
}

/**
 * The row's state hook.
 * @param view - what the row shows.
 * @returns reading, ok, block, too-large, unread or mismatch.
 */
export function codeDiffState(view: CodeDiffView): CodeDiffState {
  switch (view.kind) {
    case 'diff': return view.diff.kind === 'exact' ? 'ok' : view.diff.kind
    case 'home-too-large': return 'too-large'
    default: return view.kind
  }
}

/**
 * The row's one line.
 * @param view - what the row shows.
 * @param card - the staged card (its binding names the new code's id).
 * @returns the words.
 */
export function codeDiffWords(view: CodeDiffView, card: StagedPromotionCard): string {
  switch (view.kind) {
    case 'reading': return 'Reading the code…'
    case 'unread': return view.why
    case 'mismatch': return `the staged bytes do not hash to ${short(card.binding.candidateSha256)}, so no diff is shown`
    case 'home-too-large': {
      // Not checked, so not called the module: only the file at its path.
      const sha = view.side === 'now' ? card.incumbentSha : card.candidateSha
      return `too large to compare here: her home's file for ${sha === null ? 'it' : short(sha)} (${view.side === 'now' ? 'the code it runs now'
        : 'the new code'}) is over ${String(CODE_DIFF_MAX_SIDE_BYTES / 1024)} KiB, so it was not checked`
    }
    case 'diff': return codeDiffSummary(view.diff)
  }
}

const fromWords = (from: CodeSource): string => (from === 'published' ? 'from the published Pearl'
  : from === 'staged' ? 'from the staged Pearl' : 'from her home')
const sideWords = (from: CodeSource | 'none', sha: string | null, none: string): string =>
  (from === 'none' || sha === null ? none : `${fromWords(from)} (${short(sha)})`)
const SIGN = { ctx: ' ', del: '−', add: '+' } as const

/** The opened row: where each side came from, then the hunks, capped. */
function CodeDiffBody({ view, card }: {
  readonly view: Extract<CodeDiffView, { kind: 'diff' }>
  readonly card: StagedPromotionCard
}) {
  const { diff } = view
  const { rows, hiddenRows } = useMemo(() => codeDiffRows(diff), [diff])
  return (
    <>
      <Lead>
        <span data-code-diff-sources="">
          {`${card.binding.organId} · the code it runs now: ${sideWords(view.before, card.incumbentSha, 'none (a new organ)')} · the new code: ${
            sideWords(view.after, card.candidateSha, 'none (the organ is removed)')} · every byte shown is hash-checked here`}
        </span>
      </Lead>
      {diff.kind === 'block' ? (
        <Lead>
          Too many lines changed to compare them one by one here, so the changed part is shown as one block: what it runs now
          removed, then the new code added. The counts are the most the change can be.
        </Lead>
      ) : null}
      {diff.kind !== 'too-large' && diff.eolChanged ? <Lead>The newline at the end of the file differs, so its last line counts as changed.</Lead> : null}
      <div className="ak-diff" data-sovereignty-code-diff-body="">
        <div className="ak-diff__lines">
          {rows.map((row, index) => (row.kind === 'hunk'
            ? <div key={index} className="ak-diff__row ak-diff__hunk">{row.text}</div>
            : (
              <div key={index} className={`ak-diff__row ak-diff__${row.kind}`}>
                <span className="ak-diff__no">{row.oldNo ?? ''}</span>
                <span className="ak-diff__no">{row.newNo ?? ''}</span>
                <span className="ak-diff__sign">{SIGN[row.kind]}</span>
                <span className="ak-diff__text">{row.text}</span>
              </div>
            )))}
        </div>
      </div>
      {hiddenRows === 0 ? null
        : <Lead>{`${String(hiddenRows)} more rows of this diff are not shown here; the counts above are for the whole change.`}</Lead>}
    </>
  )
}

/**
 * Render the staged card's code diff row (closed until opened).
 * @param props - the staged card, the published code map, and the reader of her home.
 * @returns the row.
 */
export function CodeDiffRow({ promotion, published, reader, sessionId }: CodeDiffRowProps) {
  const latest = useRef<CodeDiffInput>({ promotion, published, reader, sessionId })
  latest.current = { promotion, published, reader, sessionId }
  const staged = stagedCodeOf(promotion.staged.body)
  const holds = (store: Readonly<Record<string, unknown>> | null, sha: string | null): boolean =>
    store !== null && sha !== null && Object.hasOwn(store, sha)
  // KEYED ON STRINGS, NEVER ON THE CARD OBJECT (it is read again quietly and often): the shas, what the staged bytes are,
  // the Session her home is read through, and which map holds each side (so a code map that arrives later is used).
  const key = [promotion.organChange, promotion.incumbentSha ?? '', promotion.candidateSha ?? '', promotion.bytes, sessionId ?? '',
    holds(published, promotion.incumbentSha), holds(published, promotion.candidateSha), holds(staged, promotion.candidateSha)].join('|')
  // A VIEW IS SHOWN ONLY UNDER THE KEY IT WAS READ FOR: from the first render with a new card, the row says it is reading,
  // so no diff (its counts, hunks or hooks) is ever shown under another Pearl's labels, not even for one frame.
  const [read, setRead] = useState<{ readonly key: string; readonly view: CodeDiffView }>({ key, view: READING })
  const view = read.key === key ? read.view : READING
  useEffect(() => {
    const controller = new AbortController()
    const settle = (next: CodeDiffView): void => { if (!controller.signal.aborted) setRead({ key, view: next }) }
    void readCodeDiff(latest.current, controller.signal)
      .then(settle, () => { settle({ kind: 'unread', why: 'the code could not be read' }) })
    return () => { controller.abort() }
  }, [key])
  const words = codeDiffWords(view, promotion)
  const counts = view.kind === 'diff' && view.diff.kind !== 'too-large' ? view.diff : null
  const summary = (
    <span data-sovereignty-code-diff={codeDiffState(view)}
      {...(counts === null ? {} : { 'data-code-diff-added': String(counts.added), 'data-code-diff-removed': String(counts.removed) })}>
      {words}
    </span>
  )
  return (
    <RecordList>
      <RecordRow tone={view.kind === 'mismatch' ? 'red' : 'muted'} title="View code diff" summary={summary} rowTitle={words}>
        {view.kind === 'diff' && view.diff.kind !== 'too-large' ? <CodeDiffBody view={view} card={promotion} /> : undefined}
      </RecordRow>
    </RecordList>
  )
}
