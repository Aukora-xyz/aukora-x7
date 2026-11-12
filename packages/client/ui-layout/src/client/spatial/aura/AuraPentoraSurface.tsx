// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * AURA COHERENCE: Auma's living state on the Pentora, the predecessor surface on x6.1.
 *
 * PORTAL CARDS (Round 27): the Pentora turns at the top; under it her four vitals (Coherence, Surprise Pressure, Drift
 * Risk, Wake Urgency), her recommended focus and her salience alerts, each a Portal card in Sovereignty's grid
 * (spatial-components.tsx `AuraStrip`), then the Pearl arena; last, one grid of Live activity, Live Pearl and How it
 * works. Every card closes to one line; nothing here approves anything.
 *
 * ONLY WHAT IS FED (Round 25): the Pentora turns at the centre and answers the real Session stores; the periphery strip
 * and the Pearl arena read her files and the readout; the live Pearl card reads her selected head; Live activity lists
 * real Session changes. The canon health map that sat below the figure (one portal per organ with its 18 checks and 8
 * corners, the shared-corners portal, "Health observations: not connected") is gone: no host serves a health snapshot
 * and the registration injects none, so it could only ever say "not connected". The figure still draws its health
 * layer from `absentHealth()` (model.ts), unchanged.
 *
 * LIVE ACTIVITY (SOURCE, activity.ts): the figure reacts to the real Session stores (turn running, a tool asking
 * approval, a question waiting, model steps and tool time closing, durable activity time). While any of that is
 * happening, or happened in the last 45 s, the header says WORKING · LIVE and the figure turns faster.
 * PENTORA36 (SOURCE, pentora-wasm.ts): the pinned Wasm module is fetched and run in this page the first time "How it
 * works" opens; its line there says verified, failed or not run, with the reason. It checks the module, not Auma.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AppHeader, AppSurface, FieldTable, Lead, PortalButton, PortalCell, PortalGrid, RecordList, RecordRow, StatusPill, type Tone,
} from '../primitives/index.ts'
import { AURA_COPY, AURA_SURFACE, ORGAN_FACTS, absentHealth, type AuraHealthView } from './model.ts'
import { PentoraFigure } from './PentoraFigure.tsx'
import { EMPTY_LIVE, WORKING_WINDOW_MS, absorbSessions, type LivePulse, type LiveState, type SessionFacts } from './activity.ts'
import { pentora36Once, type Pentora36Result, type Pentora36State } from './pentora-wasm.ts'
import { asNumber, asRecord, asString } from '../x5/rpc.ts'
import { isEditableTarget } from './escape.ts'
import { LiveHead } from './LiveHead.tsx'
import { NewBuildButton, sessionOf, type WorkReader } from '../work/WorkSurface.tsx'
import { useNewBuild } from '../work/autonomy.ts'
import { useReloadNotice } from '../portal/build-notice.ts'
import { AuraStrip, useAura, usePentoraAxesRef, useReadoutAura } from '../../spatial-components.tsx'

/** What the registration injects: the shared worker-file reader. */
export interface AuraSurfaceInjected {
  readonly reader: WorkReader
}

export type AuraPentoraSurfaceProps = PropsRuntime<'shell.surface'> & AuraSurfaceInjected

/** The figure's health layer: no host serves a snapshot, so every cell is an absent report (model.ts). */
const FIGURE_HEALTH: AuraHealthView = absentHealth()

function ago(ms: number | null): string {
  if (ms === null) return 'never observed'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${String(s)} s ago`
  return s < 3600 ? `${String(Math.round(s / 60))} min ago` : `${String(Math.round(s / 3600))} h ago`
}

/** Organ name for a live row. */
function organWords(organ: LivePulse['organ']): string {
  return organ === null ? 'the whole figure' : ORGAN_FACTS[organ].title
}

function pulseStatus(pulse: LivePulse) {
  if (pulse.outcome === 'door-refused') return <StatusPill tone="muted">refused</StatusPill>
  if (pulse.outcome === 'door-asked') return <StatusPill tone="gold">waiting</StatusPill>
  if (pulse.outcome === 'error') return <StatusPill tone="gold">failed</StatusPill>
  return undefined
}

/** What Auma is doing, as it happens: every row is a real session event. With none yet, the summary says so. */
function LivePortal({ live }: { readonly live: LiveState }) {
  const [openLive, setOpenLive] = useState(false)
  const rows = [...live.pulses].reverse().slice(0, 24)
  const summary = live.working
    ? `Auma is at work · ${String(live.pulses.length)} events seen`
    : live.pulses.length === 0
      ? 'nothing since you opened this view; it moves when Auma works'
      : `${String(live.pulses.length)} events since you opened this view`
  return (
    <PortalButton
      tone="violet"
      icon="model"
      title="Live activity"
      summary={summary}
      badge={live.working ? <StatusPill tone="violet">working</StatusPill> : undefined}
      expanded={openLive}
      onToggle={setOpenLive}
    >
      <Lead>Real Session changes, without their content. A tool is named only when it asks your approval.</Lead>
      {rows.length === 0 ? null : (
        <RecordList>
          {rows.map(pulse => (
            <RecordRow
              key={pulse.id}
              tone={pulse.organ === null ? 'muted' : ORGAN_FACTS[pulse.organ].tone}
              title={pulse.label}
              summary={`${organWords(pulse.organ)} · ${pulse.session} · ${ago(pulse.at)}`}
              status={pulseStatus(pulse)}
            />
          ))}
        </RecordList>
      )}
    </PortalButton>
  )
}

/** The legend, only what the figure really does, and last the module's own self-check. */
function HowItWorks({ pentora36 }: { readonly pentora36: Pentora36Result | null }) {
  return (
    <>
      <Lead>
        Five organs, one cube each: AUMLOK gold, Gate &amp; Aura blue, Kira violet, Network mint, Body silver. A cube flashes and
        shakes loose when Auma does something that organ handles, then fades in seconds. The figure turns faster while she
        works: a turn is open, a request waits on you, or a Session changed in the last 45 seconds.
      </Lead>
      <Lead>Below, the pinned Pentora36 Wasm module runs in this page against its own fixtures: it checks the module, not Auma.</Lead>
      <Pentora36Line result={pentora36} />
      {/* NORTH-STAR §18.2 Binding UI Law: the self-check is said apart from health, which no host serves yet. */}
      <Lead><span data-aura-health-unconnected="">Health observations: not connected (sequence 0). No cube is ever shown healthy.</span></Lead>
    </>
  )
}

type SessionsShape = Parameters<typeof sessionOf>[0] & {
  readonly byId: Readonly<Record<string, { readonly displayTitle?: string; readonly running?: boolean; readonly updatedAt?: number }>>
  readonly projectionsBySession?: unknown
}

/** Read one Session's live facts from the list row, its held projections and its UI status. */
function factsOf(id: string, sessions: SessionsShape, status: unknown): SessionFacts {
  const row = sessions.byId[id]
  const stats = asRecord(asRecord(asRecord(asRecord(sessions.projectionsBySession)[id]).values).sessionStats)
  const live = asRecord(status)
  const pending = asRecord(live.pendingInteraction)
  const key = asString(pending.key)
  const running = typeof live.running === 'boolean' ? live.running : row?.running === true
  return {
    id,
    title: row?.displayTitle ?? id,
    running,
    updatedAt: asNumber(row?.updatedAt),
    steps: asNumber(stats.steps),
    toolMs: asNumber(stats.toolMs),
    pending: key === null ? null : { key, kind: asString(pending.kind) ?? 'request', toolName: asString(pending.toolName) },
  }
}

const WASM_TONE: Readonly<Record<Pentora36State, Tone>> = { verified: 'mint', failed: 'red', 'not-run': 'muted' }
const WASM_WORD: Readonly<Record<Pentora36State, string>> = { verified: 'verified', failed: 'failed', 'not-run': 'not run' }

/**
 * Fetch and run the Pentora36 module once, when the surface opens: a pass sits in How it works, and a failure (a served
 * module that is not the pinned one, or checks that fail) shows under the figure, where it cannot be missed.
 */
function usePentora36(wanted: boolean): Pentora36Result | null {
  const [result, setResult] = useState<Pentora36Result | null>(null)
  useEffect(() => {
    if (!wanted || result !== null) return
    let live = true
    void pentora36Once().then((next) => { if (live) setResult(next) })
    return () => { live = false }
  }, [wanted, result])
  return result
}

/**
 * The arithmetic self-check in words, counted from the checks the module actually ran (never a fixed "9/9").
 * @param result - the module verdict, or null while it runs.
 */
export function arithmeticWords(result: Pentora36Result | null): string {
  if (result === null) return 'Arithmetic self-check: running'
  const passed = result.checks.filter(check => check.ok).length
  const total = result.checks.length
  if (result.state === 'verified') return `Arithmetic self-check: ${String(passed)}/${String(total)} verified`
  if (result.state === 'failed') return `Arithmetic self-check: failed (${String(passed)}/${String(total)})`
  return 'Arithmetic self-check: not run'
}

/** The Pentora36 module's arithmetic self-check: what it ran, or why it did not run. It is not a health observation. */
function Pentora36Line({ result }: { readonly result: Pentora36Result | null }) {
  const state: Pentora36State = result?.state ?? 'not-run'
  const title = arithmeticWords(result)
  const reason = result === null ? 'running the pinned module in this page…' : result.reason
  return (
    <RecordList>
      <RecordRow
        tone={WASM_TONE[state]}
        title={title}
        rowTitle={`${title} — ${reason}`}
        summary={reason}
        status={<StatusPill tone={WASM_TONE[state]}>{result === null ? 'running' : WASM_WORD[state]}</StatusPill>}
      >
        <FieldTable rows={[
          ['module', result?.sha256 ?? 'not hashed'],
          ['bytes', result === null || result.bytes === null ? '—' : String(result.bytes)],
          ['loaded', result?.loader ?? '—'],
          ['time', result === null ? '—' : `${String(result.ms)} ms`],
          ...(result?.checks ?? []).map((c): [string, string] => [`${c.ok ? 'pass' : 'FAIL'} · ${c.name}`, c.detail]),
          ['authority', 'none · an arithmetic self-check of the module, not a health verdict'],
        ]}
        />
      </RecordRow>
    </RecordList>
  )
}

/**
 * Render the always-mounted Aura Coherence surface.
 * @param props - composed shell-surface props and the shared file reader.
 * @returns the surface element tree.
 */
export function AuraPentoraSurface({
  activeSurface, closeSurface, useSessions, useSessionStatus, reader,
}: AuraPentoraSurfaceProps) {
  const active = activeSurface === AURA_SURFACE
  const [howOpen, setHowOpen] = useState(false)
  /** A newer runtime release the host selected (Round 13): one inline Reload button, never a popup. */
  const newBuild = useNewBuild(active)
  /** The edge's own build and her published head: the same Reload button, when the host selects nothing. */
  const reloadNotice = useReloadNotice(active)
  const sessionId: SessionId | undefined = useSessions(sessionOf)
  // THE PERIPHERY (Round 14): the readout's recomputed aura.v1 (when it carries one) with her own files; only a
  // recomputed vector moves the figure.
  const auraProjection = useReadoutAura(active, reader, sessionId)
  const aura = useAura(active, reader, sessionId, auraProjection)
  const auraAxes = usePentoraAxesRef(aura)

  // LIVE: the real Session stores (list rows, held projections, UI status), folded into pulses. See activity.ts.
  const sessions = useSessions(state => state) as unknown as SessionsShape
  const statuses = useSessionStatus(state => state)
  const entries = useMemo(
    () => sessions.ids.filter(id => !String(id).startsWith('preview-')).map(id => factsOf(String(id), sessions, statuses.get(id))),
    [sessions, statuses],
  )
  const baselines = useRef(new Map<string, SessionFacts>())
  const liveRef = useRef<LiveState>(EMPTY_LIVE)
  const [live, setLive] = useState<LiveState>(liveRef.current)
  const [clock, setClock] = useState(0)
  useEffect(() => {
    const next = absorbSessions(liveRef.current, baselines.current, entries, Date.now())
    if (next !== liveRef.current) {
      liveRef.current = next
      setLive(next)
    }
  }, [entries, clock])
  // The 45 s window closes on its own: re-read while it is open and the surface is shown.
  useEffect(() => {
    if (!active || !live.working) return
    const timer = setInterval(() => { setClock(n => n + 1) }, Math.round(WORKING_WINDOW_MS / 9))
    return () => { clearInterval(timer) }
  }, [active, live.working])
  const pentora36 = usePentora36(active)

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isEditableTarget(event.target)) return
      event.preventDefault()
      closeSurface()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [active, closeSurface])

  return (
    <AppSurface active={active} data-aura-coherence-surface="">
      <AppHeader
        eyebrow={AURA_COPY.eyebrow}
        title={AURA_COPY.title}
        tone="violet"
        badges={[
          live.working
            ? { text: 'WORKING · LIVE', tone: 'violet' as const, title: 'A Session is working now or changed in the last 45 seconds' }
            : { text: AURA_COPY.readOnly, icon: 'lock', title: AURA_COPY.readOnlyTitle },
        ]}
      />
      <NewBuildButton release={newBuild} notice={reloadNotice} />
      <PentoraFigure view={FIGURE_HEALTH} active={active} focus={null} live={liveRef} aura={auraAxes} />
      {pentora36?.state === 'failed' ? <div data-pentora36-failed=""><Pentora36Line result={pentora36} /></div> : null}
      <AuraStrip read={aura} />
      <PortalGrid open={false}>
        <PortalCell data-aura-card="live"><LivePortal live={live} /></PortalCell>
        <PortalCell data-aura-card="pearl"><LiveHead active={active} reader={reader} sessionId={sessionId} /></PortalCell>
        <PortalCell data-aura-card="how">
          <PortalButton
            tone="violet"
            icon="aura"
            title="How it works"
            summary="what the colours and movement mean"
            expanded={howOpen}
            onToggle={setHowOpen}
          >
            <HowItWorks pentora36={pentora36} />
          </PortalButton>
        </PortalCell>
      </PortalGrid>
    </AppSurface>
  )
}
