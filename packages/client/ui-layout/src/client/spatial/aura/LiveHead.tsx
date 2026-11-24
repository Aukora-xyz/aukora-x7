// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * GATE & AURA · LIVE PEARL: Auma's selected Pearl and how many organs it carries, on the Aura Coherence view.
 *
 * Read from her own worker file for the shown Session (`/dsh/home/balls/HEAD.json`), the head her loader runs. This is
 * what the file SAYS: it is not a health check, it verifies no hash and it grants nothing. A file that could not be read
 * says so; it is never shown as an empty body. (Round 25 dropped her seed manifest's organ list: an older file than the
 * head, with fewer organs than her Pearl runs.)
 *
 * LIVE (Round 13): her ball commits and the host's mirror pushes re-read the head at once (one read per 150 ms burst),
 * so a promotion shows here without a refresh; the 15 s poll stays as the fallback.
 */
import { useEffect, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FieldTable, Lead, PortalButton, SectionLabel, StatusPill } from '../primitives/index.ts'
import { BALL_HEAD_PATH, parseHead, type HeadView } from '../work/work-model.ts'
import type { FileRead, WorkReader } from '../work/WorkSurface.tsx'
import { COMMIT_FOLLOW_UPS, touchesHer, useDebounced, useLiveEvents } from '../work/autonomy.ts'

const POLL_MS = 15_000

/**
 * Count the organs her selected ball head carries (`entries` in `/dsh/home/balls/HEAD.json`): the live count.
 * @returns the entry count and how many are enabled, or null when the text has no `entries` object.
 */
export function parseHeadOrgans(text: string): { readonly total: number; readonly enabled: number } | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const entries = (raw as { entries?: unknown }).entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return null
  const rows = Object.values(entries as Record<string, unknown>)
  const enabled = rows.filter(row => row !== null && typeof row === 'object' && (row as { disabled?: unknown }).disabled !== true).length
  return { total: rows.length, enabled }
}

type Read<T> = { kind: 'idle' } | { kind: 'ok'; value: T } | { kind: 'unreadable'; reason: string }

const IDLE = { kind: 'idle' } as const

function settle<T>(read: FileRead, parse: (text: string) => T | null): Read<T> {
  if (!read.ok) return { kind: 'unreadable', reason: read.reason }
  const value = parse(read.text)
  return value === null ? { kind: 'unreadable', reason: 'not the expected JSON shape' } : { kind: 'ok', value }
}

const short = (id: string | null): string => (id === null ? '—' : id.slice(0, 12))

export function LiveHead({ active, reader, sessionId }: {
  readonly active: boolean
  readonly reader: WorkReader
  readonly sessionId: SessionId | undefined
}) {
  const [open, setOpen] = useState(false)
  const [head, setHead] = useState<Read<HeadView>>(IDLE)
  const [headOrgans, setHeadOrgans] = useState<Read<{ readonly total: number; readonly enabled: number }>>(IDLE)
  const [liveTick, setLiveTick] = useState(0)
  const reread = useDebounced(() => { setLiveTick(n => n + 1) })
  useLiveEvents(active, (event) => {
    if (event.kind === 'ball-commit' || (event.kind === 'mirror-updated' && touchesHer(event.changedPaths))) reread.poke()
    if (event.kind === 'ball-commit') reread.followUp(COMMIT_FOLLOW_UPS)
  })
  useEffect(() => { if (!active) reread.cancel() }, [active, reread])

  useEffect(() => {
    if (!active || sessionId === undefined) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Settle, then schedule: a slow read is never aborted by the next tick.
    const tick = async () => {
      const h = await reader.whole(sessionId, BALL_HEAD_PATH, controller.signal)
      if (controller.signal.aborted) return
      setHead(settle(h, parseHead))
      setHeadOrgans(settle(h, parseHeadOrgans))
      timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [active, reader, sessionId, liveTick])

  const headWords = head.kind === 'ok'
    ? `Pearl ${String(head.value.epoch ?? '—')} · ${short(head.value.ballId)}`
    : head.kind === 'unreadable' ? 'head unreadable' : 'reading head…'
  const organWords = headOrgans.kind === 'ok'
    ? `${String(headOrgans.value.total)} organs in her Pearl`
    : headOrgans.kind === 'unreadable' ? 'organs unreadable' : 'reading organs…'
  const known = head.kind === 'ok'

  return (
    <PortalButton
      tone="blue"
      icon="approvals"
      iconTone="blue"
      data-aura-live-head=""
      title="Live Pearl"
      summary={sessionId === undefined ? 'no live Session is shown, so there is nothing to read' : `${headWords} · ${organWords}`}
      badge={<StatusPill tone={known ? 'blue' : 'muted'}>{known ? 'read from her head file' : 'not read'}</StatusPill>}
      expanded={open}
      onToggle={setOpen}
    >
      <Lead>
        What her head file says now. No hash is checked here and nothing is granted; Sovereignty runs her receipt-chain verify.
      </Lead>
      <SectionLabel>Selected Pearl</SectionLabel>
      {head.kind === 'ok'
        ? (
          <FieldTable rows={[
            ['epoch', String(head.value.epoch ?? '—')],
            ['Pearl ID', head.value.ballId ?? '—'],
            ['parent Pearl', head.value.parentBallId ?? '—'],
            ['organs in her Pearl', headOrgans.kind === 'ok' ? `${String(headOrgans.value.total)} (${String(headOrgans.value.enabled)} enabled)` : '—'],
            ['file', BALL_HEAD_PATH],
          ]}
          />
        )
        : <Lead>{head.kind === 'unreadable' ? `Could not read ${BALL_HEAD_PATH}: ${head.reason}` : 'Reading…'}</Lead>}
    </PortalButton>
  )
}
