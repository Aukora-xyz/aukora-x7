// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The predecessor's x5 surface helpers (an earlier repository), on x6.1's own DSH API (`./rpc.ts`).
 * @module x5/common
 */
import { useEffect, useState, type ReactNode } from 'react'
import { AppHeader, AppSurface, RecordRow, StatusPill, type Badge } from '../primitives/index.ts'
import { dshRpc } from './rpc.ts'

/** The predecessor's centre-lane frame: an app surface, its header (eyebrow, title, badges) and optional header slots. */
export function SurfaceFrame({ active, eyebrow, title, badges = [], headerBelow, headerCenter, headerActions, headerClassName = '', children, ...data }: {
  readonly active: boolean
  readonly eyebrow: string
  readonly title: string
  readonly badges?: readonly Badge[]
  readonly headerBelow?: ReactNode
  readonly headerCenter?: ReactNode
  readonly headerActions?: ReactNode
  readonly headerClassName?: string
  readonly children: ReactNode
} & Record<`data-${string}`, string | undefined>) {
  return (
    <AppSurface active={active} data-settings-surface="" {...data}>
      <div className={`x5-app-header ${headerClassName}`}>
        <AppHeader eyebrow={eyebrow} title={title} badges={badges} />
        {headerBelow ? <div className="x5-app-header__below">{headerBelow}</div> : null}
        {headerCenter ? <div className="x5-app-header__center">{headerCenter}</div> : null}
        {headerActions ? <div className="x5-app-header__actions">{headerActions}</div> : null}
      </div>
      {children}
    </AppSurface>
  )
}

/**
 * Run DSH calls while `active`, keep the last answers, and reload on demand. Inactive surfaces call nothing.
 * @param calls - `[method, args?]` pairs.
 * @param active - only an open surface reads.
 * @returns the answers (in call order), the last error, and `reload`.
 */
export function useDshCalls(calls: readonly (readonly [string, Record<string, unknown>?])[], active = true) {
  const [state, setState] = useState<{ values: unknown[]; error: string | null; loaded: boolean }>(
    { values: [], error: null, loaded: false })
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify(calls)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    Promise.all(calls.map(([method, args]) => dshRpc(method, args ?? {}, controller.signal))).then((values) => {
      if (!controller.signal.aborted) setState({ values, error: null, loaded: true })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setState(current => ({ ...current, loaded: true, error: error instanceof Error ? error.message : String(error) }))
    })
    return () => { controller.abort() }
  }, [key, revision, active])
  return { ...state, reload: () => { setRevision(value => value + 1) } }
}

/** Read a nested value; anything not an object along the way is `undefined`. */
export function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** One settings write through the same `settings/mutate` the stock settings page uses, guarded by revision. */
export async function writeSetting(ns: string, path: readonly string[], value: unknown, expectedRevision: number, unset = false) {
  return dshRpc('settings/mutate', {
    ns,
    ops: [unset ? { op: 'unset', path: [...path] } : { op: 'set', path: [...path], value }],
    expectedRevision,
  })
}

export function SettingChoice({ title, summary, value, choices, disabled, onChange }: {
  readonly title: string
  readonly summary: string
  readonly value: unknown
  readonly choices: readonly (readonly [string, string])[]
  readonly disabled: boolean
  readonly onChange: (value: string) => void
}) {
  return (
    <RecordRow tone="blue" title={title} summary={`${summary} · ${String(value ?? 'system')}`}>
      <select className="x5-field" value={String(value ?? '')} disabled={disabled} onChange={(event) => { onChange(event.currentTarget.value) }}>
        {choices.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </RecordRow>
  )
}

export function SettingNumber({ title, value, min, max, disabled, onChange }: {
  readonly title: string
  readonly value: unknown
  readonly min: number
  readonly max: number
  readonly disabled: boolean
  readonly onChange: (value: number) => void
}) {
  return (
    <RecordRow tone="blue" title={title} summary={`${String(value)} px`}>
      <input
        className="x5-field"
        type="number"
        min={min}
        max={max}
        value={Number(value)}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.currentTarget.value)
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next)
        }}
      />
    </RecordRow>
  )
}

export function ErrorLine({ error }: { readonly error: string | null }) {
  return error ? <p className="x5-error" role="alert">{error}</p> : null
}

/** Flat `[key, value]` rows for a record's primitive fields (and arrays of primitives), for a FieldTable. */
export function primitiveFields(value: unknown, prefix = ''): [string, string][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]): [string, string][] => {
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) return [[`${prefix}${key}`, String(item)]]
    if (Array.isArray(item) && item.every(entry => ['string', 'number'].includes(typeof entry))) return [[`${prefix}${key}`, item.join(' · ')]]
    return []
  })
}

export function LiveBadge({ connected }: { readonly connected: boolean }) {
  return <StatusPill tone={connected ? 'mint' : 'muted'}>{connected ? 'LIVE' : 'NOT CONNECTED YET'}</StatusPill>
}
