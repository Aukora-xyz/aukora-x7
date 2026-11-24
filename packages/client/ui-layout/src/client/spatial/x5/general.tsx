// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The predecessor's General settings surface (an earlier repository), on x6.1's own DSH API.
 *
 * Reads `settings/describe` and writes each row through `settings/mutate` with the namespace's `expectedRevision`
 * (the same call the stock settings page makes). Namespaces and fields are the stock ones: `locale.preference`,
 * `ui-theme.{preference,fontSize,codeFontSize,terminalFontSize}`, `ui-chat.{transcriptView,collapseTiming,
 * linkOpening,performanceUsage}`, `ui-conversation.busyEnter`.
 * @module x5/general
 */
import { useState } from 'react'
import { Lead, RecordList } from '../primitives/index.ts'
import { ErrorLine, SettingChoice, SettingNumber, SurfaceFrame, useDshCalls, valueAt, writeSetting } from './common.tsx'
import { asArray, asNumber, asRecord, asString, valueOf } from './rpc.ts'

type Choices = readonly (readonly [string, string])[]

const LOCALES: Choices = [['', 'System'], ['en', 'English'], ['zh', '中文']]
const THEMES: Choices = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]
const TRANSCRIPT: Choices = [['compact', 'Compact'], ['standard', 'Standard'], ['detailed', 'Detailed'], ['verbose', 'Verbose']]
const COLLAPSE: Choices = [['completion', 'On completion'], ['next-input', 'Next input']]
const LINKS: Choices = [['sidebar', 'In sidebar'], ['new-tab', 'New tab']]
const USAGE: Choices = [['compact', 'Compact'], ['detailed', 'Detailed']]
const ENTER: Choices = [['queue', 'Queue next message'], ['steer', 'Steer current turn']]

/** The three font roles, with the stock `ui-theme` bounds and defaults (`FONT_SIZE_SPECS`). */
const FONT_SIZES = [
  { field: 'fontSize', title: 'Text size', min: 10, max: 22, fallback: 14 },
  { field: 'codeFontSize', title: 'Code size', min: 10, max: 16, fallback: 11 },
  { field: 'terminalFontSize', title: 'Terminal size', min: 10, max: 20, fallback: 13 },
] as const

/** One namespace view as `settings/describe` answers it (only the fields this surface reads). */
export interface NamespaceView {
  readonly ns: string
  readonly revision: number
  readonly value: unknown
}

/**
 * The namespace views of one `settings/describe` answer.
 * @param description - the describe value.
 * @returns every view that carries an `ns` and a numeric `revision`.
 */
export function namespaceViews(description: unknown): NamespaceView[] {
  return asArray(asRecord(description).namespaces).flatMap((row): NamespaceView[] => {
    const record = asRecord(row)
    const ns = asString(record.ns)
    const revision = asNumber(record.revision)
    return ns === null || revision === null ? [] : [{ ns, revision, value: record.value }]
  })
}

/**
 * The General settings surface: language, appearance, conversation density and font sizes, read and written live.
 * @param props - `active` while this surface is the centre Stage's selection.
 * @returns the surface (hidden and idle while inactive).
 */
export function GeneralSurface({ active }: { readonly active: boolean }) {
  const { values, error, reload } = useDshCalls([['settings/describe']], active)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const description = values[0] === undefined ? undefined : asRecord(valueOf(values[0]))
  const writable = description?.writable === true
  const namespaces = namespaceViews(description)
  const namespace = (ns: string) => namespaces.find(row => row.ns === ns)

  const mutate = async (ns: string, path: readonly string[], value: unknown) => {
    const current = namespace(ns)
    if (!current || busy) return
    setBusy(true)
    setWriteError(null)
    try {
      await writeSetting(ns, path, value, current.revision, value === '')
      reload()
    } catch (cause) {
      setWriteError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const choice = (ns: string, path: readonly string[], title: string, summary: string, choices: Choices) => {
    const current = namespace(ns)
    return (
      <SettingChoice
        title={title}
        summary={summary}
        value={valueAt(current?.value, path)}
        choices={choices}
        disabled={!current || !writable || busy}
        onChange={(value) => { void mutate(ns, path, value) }}
      />
    )
  }

  return (
    <SurfaceFrame active={active} eyebrow="DeepSeek Harness · live settings" title="General" data-settings-section="general"
      badges={[{ text: writable ? 'LIVE · DSH' : 'READ-ONLY', tone: writable ? 'mint' : 'muted' }]}>
      {!description && !error ? <Lead>Reading the live settings document from DSH.</Lead> : null}
      <RecordList>
        {choice('locale', ['preference'], 'Language', 'DSH locale', LOCALES)}
        {choice('ui-theme', ['preference'], 'Appearance', 'DSH colour scheme', THEMES)}
        {choice('ui-chat', ['transcriptView'], 'Transcript view', 'Conversation density', TRANSCRIPT)}
        {choice('ui-chat', ['collapseTiming'], 'Collapse completed steps', 'When tool details fold', COLLAPSE)}
        {choice('ui-chat', ['linkOpening'], 'Open links', 'Where conversation links open', LINKS)}
        {choice('ui-conversation', ['busyEnter'], 'Enter while working', 'Composer behavior during a turn', ENTER)}
        {choice('ui-chat', ['performanceUsage'], 'Performance and usage', 'Usage detail', USAGE)}
        {FONT_SIZES.map(({ field, title, min, max, fallback }) => {
          const current = namespace('ui-theme')
          return (
            <SettingNumber
              key={field}
              title={title}
              value={valueAt(current?.value, [field]) ?? fallback}
              min={min}
              max={max}
              disabled={!current || !writable || busy}
              onChange={(value) => { void mutate('ui-theme', [field], value) }}
            />
          )
        })}
      </RecordList>
      <ErrorLine error={writeError ?? error} />
    </SurfaceFrame>
  )
}
