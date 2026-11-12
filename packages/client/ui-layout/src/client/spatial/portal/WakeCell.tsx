// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE WAKE CARD ON SOVEREIGNTY (Round 24): whether anything wakes her, what the last wake was, and ONE CLICK THAT PAUSES
 * EVERY WAKE: the host's timer (`POST /_host/wake` configure, enabled false) and every active scheduled task on this host,
 * hers and yours (the host's schedule service, `active: false`). The pause sits outside the card's fold, so it is one
 * click from the closed card. Resuming is the other way round: one wake at a time, inside the card, and only after a
 * second click that says what it will start. Every answer is shown as the host gave it, and both are read again after
 * any change.
 * @module portal/WakeCell
 */
import { useEffect, useState, type ReactNode } from 'react'
import { postWake, readWake, WAKE_MAX_MS, WAKE_MIN_MS, wakeInterval, type WakeRead, type WakeStatus } from '../work/autonomy.ts'
import { FieldTable, PortalButton, StatusPill } from '../primitives/index.ts'
import {
  everyWords, hostTimerWords, lastWakeWords, readSchedules, scheduleWords, wakeStateOf, wakeSummaryWords, withDeadline,
  type ScheduleDoor, type ScheduleRead, type ScheduleRow,
} from './sovereignty-panels.ts'

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
/**
 * A wake answer that does not settle what happened: no answer, or the host's own 5xx (the change may have been stored).
 * Only a 4xx (or an HTML page) is the host saying it did not do it.
 */
const unclearWake = (answer: WakeRead): boolean => answer.kind === 'refused' && (answer.status === 0 || answer.status >= 500)
const answerDetail = (answer: WakeRead | Error): string => (answer instanceof Error ? answer.message : answer.kind === 'ok' ? 'ok' : answer.detail)
/** A wake call with the same deadline as the schedule calls: its answer, or the Error that says none came in time. */
const timed = <T,>(call: Promise<T>): Promise<T | Error> =>
  withDeadline(call).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))

/**
 * Pause or resume one schedule through the door, and say what the host answered. Both carry the revision the task was
 * read at, so neither overwrites a task that changed meanwhile (a one-off task that finished is never turned "paused").
 * A PAUSE THAT LOSES A RACE (a delivery moved the revision) reads that task again and pauses again only if it is still
 * active, up to three times; a resume that loses one is reported, never retried.
 * @param door - the schedule service door.
 * @param row - the schedule as last read.
 * @param active - false pauses, true resumes.
 * @returns one line.
 */
export async function setScheduleActive(door: ScheduleDoor | undefined, row: ScheduleRow, active: boolean): Promise<string> {
  const verb = active ? 'resumed' : 'paused'
  const api = door?.current() ?? null
  if (api === null) return `${row.title}: NOT ${verb} (this page has no schedule service on this host)`
  let current = row
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let value: unknown
    try {
      const answer = await withDeadline(api.edit({ id: current.id, action: 'update', patch: { active }, expectedUpdatedAt: current.updatedAt }))
      if (!answer.ok) return `${row.title}: NOT ${verb} (${answer.error.code})`
      value = answer.value
    } catch (error) {
      return `${row.title}: no clear answer (${error instanceof Error ? error.message : String(error)}); read again`
    }
    if (isRecord(value) && value.code === 'schedule_not_found') return `${row.title}: NOT ${verb}: the host no longer has it`
    if (isRecord(value) && value.code === 'schedule_conflict') {
      if (active) return `${row.title}: NOT resumed: it changed since it was read; read again`
      const fresh = await readSchedules(door)
      if (fresh.kind !== 'ok') return `${row.title}: NOT paused: it changed, and could not be read again (${fresh.kind === 'unavailable' ? fresh.reason : 'reading'})`
      const again = fresh.rows.find(candidate => candidate.id === current.id)
      if (again === undefined) return `${row.title}: the host no longer has it`
      if (again.status !== 'active') return again.status === 'ended' ? `${row.title}: finished on its own; nothing to pause` : `${row.title}: already paused`
      current = again
      continue
    }
    if (isRecord(value) && typeof value.status === 'string') {
      return value.status === (active ? 'active' : 'paused') ? `${row.title}: ${verb}` : `${row.title}: the host answered, and it is ${value.status}`
    }
    return `${row.title}: the host's answer is not the expected shape`
  }
  return `${row.title}: NOT paused: it kept changing while this page tried (three tries); read again`
}

/** Whether the view is open, its Refresh round, and the schedule service door. */
export interface WakeCellProps {
  readonly active: boolean
  readonly round: number
  readonly door: ScheduleDoor | undefined
}

/**
 * The interval a resume asks for: the host's stored one when it is a valid interval (a 60 s timer stays 60 s), else the
 * Work view's default. The confirm names it before anything is sent.
 */
const resumeInterval = (status: WakeStatus): number => (status.intervalMs !== null && status.intervalMs >= WAKE_MIN_MS
  && status.intervalMs <= WAKE_MAX_MS ? status.intervalMs : wakeInterval(status))

/** What a resume button is waiting to confirm: the host timer at the interval the confirm names, or one task. */
type Pending = { readonly kind: 'host'; readonly intervalMs: number } | { readonly kind: 'schedule'; readonly row: ScheduleRow }

/**
 * The wake card.
 * @param props - whether the view is open, its Refresh round, and the schedule service door.
 * @returns the card's contents (inside a PortalCell).
 */
export function WakeCell({ active, round, door }: WakeCellProps) {
  const [host, setHost] = useState<WakeRead | null>(null)
  const [schedules, setSchedules] = useState<ScheduleRead>({ kind: 'reading' })
  const [busy, setBusy] = useState(false)
  // What the host answered the last pause or resume, the timer's words first; each half shows as soon as it is in.
  const [said, setSaid] = useState<{ readonly timer: readonly string[]; readonly tasks: readonly string[] } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [reads, setReads] = useState(0)
  useEffect(() => {
    if (!active) return
    let live = true
    setHost(null)
    setSchedules({ kind: 'reading' })
    // The card's own read has the same deadline: a host that never answers is said as not read, never "reading" for good.
    void timed(readWake()).then((read) => { if (live) setHost(read instanceof Error ? { kind: 'refused', status: 0, detail: read.message } : read) })
    void readSchedules(door).then((read) => { if (live) setSchedules(read) })
    return () => { live = false }
  }, [active, round, reads, door])
  useEffect(() => { if (!active) { setSaid(null); setPending(null) } }, [active])

  const state = wakeStateOf(host, schedules)
  // Pause is offered whenever "all paused" is not confirmed: something is active, or a source was not read.
  const pausable = state.kind === 'active' || state.kind === 'unconfirmed'
  /** Run the timer half and the task half side by side; each answer shows when it is in, and both are read again after. */
  const run = (timerHalf: () => Promise<readonly string[]>, taskHalf: () => Promise<readonly string[]>): void => {
    if (busy) return
    setBusy(true)
    setPending(null)
    setSaid({ timer: [], tasks: [] })
    // A half that finishes after the view closed (which clears the line) does not bring the line back.
    const show = (half: 'timer' | 'tasks') => (lines: readonly string[]): void => {
      setSaid(previous => (previous === null ? null : { ...previous, [half]: lines }))
    }
    void Promise.all([timerHalf().then(show('timer')), taskHalf().then(show('tasks'))])
      .finally(() => { setBusy(false); setReads(n => n + 1) })
  }
  // ONE CLICK: every wake active AT THE CLICK, each source read again first (so a read still in flight on the card cannot
  // make it skip one), the two in parallel (a slow task catalog never holds the timer's pause back). The timer's pause
  // sends no interval, so the host keeps the one it has.
  const pauseTimer = async (): Promise<readonly string[]> => {
    const timer = await timed(readWake())
    if (timer instanceof Error) return [`host timer: not read, so not paused (${timer.message})`]
    if (timer.kind === 'refused') return [`host timer: not read, so not paused (${timer.detail})`]
    if (timer.kind !== 'ok') return []
    if (!timer.status.enabled) return ['host timer: already paused']
    const answer = await timed(postWake({ action: 'configure', enabled: false }))
    if (answer instanceof Error || unclearWake(answer)) return [`host timer: no clear answer (${answerDetail(answer)}); read again`]
    return [answer.kind === 'ok' ? (answer.status.enabled ? 'host timer: the host answered, and it is still ON' : 'host timer: paused')
      : `host timer: NOT paused (${answer.detail})`]
  }
  const pauseTasks = async (): Promise<readonly string[]> => {
    if (door?.current() == null) return ['scheduled tasks: not read here, so not paused (this page has no schedule service on this host)']
    const plans = await readSchedules(door)
    if (plans.kind !== 'ok') return [`scheduled tasks: not read, so not paused (${plans.kind === 'unavailable' ? plans.reason : 'reading'})`]
    const lines: string[] = []
    for (const row of plans.rows.filter(plan => plan.status === 'active')) lines.push(await setScheduleActive(door, row, false))
    if (plans.unread > 0) lines.push(`${String(plans.unread)} task${plans.unread === 1 ? '' : 's'} this page cannot read: not paused`)
    if (lines.length === 0) lines.push(plans.rows.length === 0 ? 'scheduled tasks: none' : 'scheduled tasks: none active')
    return lines
  }
  const pauseAll = (): void => { run(pauseTimer, pauseTasks) }
  const none = async (): Promise<readonly string[]> => []
  const resume = (what: Pending): void => {
    if (what.kind === 'schedule') {
      run(none, async () => [await setScheduleActive(door, what.row, true)])
      return
    }
    // The timer is read again at the confirm (a timer someone turned on meanwhile is said to be on, not "resumed"), and it
    // is resumed at exactly the interval the confirm named.
    run(async () => {
      const timer = await timed(readWake())
      if (timer instanceof Error || timer.kind !== 'ok') return ['host timer: not read, so not resumed']
      if (timer.status.enabled) return ['host timer: already on']
      const answer = await timed(postWake({ action: 'configure', enabled: true, intervalMs: what.intervalMs }))
      if (answer instanceof Error || unclearWake(answer)) return [`host timer: no clear answer (${answerDetail(answer)}); read again`]
      return [answer.kind === 'ok' ? (answer.status.enabled ? 'host timer: resumed' : 'host timer: the host answered, and it is still off')
        : `host timer: NOT resumed (${answer.detail})`]
    }, none)
  }
  const resumeButton = (what: Pending, label: string) => (
    <button type="button" className="x5-field" data-sovereignty-wake-resume={what.kind === 'host' ? 'host' : what.row.id} disabled={busy}
      onClick={() => { setPending(what) }}>
      {label}
    </button>
  )

  // ONLY WHAT A SOURCE SAID (Round 25): the timer and its last wake when the host answered (its refusal when it refused),
  // each task the host lists, and tasks it could not list or this page could not read. Nothing for a source that is silent.
  const rows: [string, ReactNode][] = [
    ...(host?.kind === 'ok' || host?.kind === 'refused' ? [['host wake timer', (
      <>
        {hostTimerWords(host)}
        {host.kind === 'ok' && !host.status.enabled ? <>{' '}{resumeButton({ kind: 'host', intervalMs: resumeInterval(host.status) }, 'Resume…')}</> : null}
      </>
    )] as [string, ReactNode]] : []),
    // The last wake only when there was one (a host that never woke her, or names no time, has nothing to show here).
    ...(host?.kind === 'ok' && (host.status.lastReceipt !== null || (!host.status.neverWoke && host.status.lastWakeAt !== null))
      ? [['last wake', lastWakeWords(host)] as [string, ReactNode]] : []),
    ...(schedules.kind === 'ok'
      ? schedules.rows.map((row): [string, ReactNode] => [row.title, (
        <>
          {scheduleWords(row)}
          {row.status === 'paused' ? <>{' '}{resumeButton({ kind: 'schedule', row }, 'Resume…')}</> : null}
        </>
      )])
      : schedules.kind === 'unavailable' && door?.current() != null ? [['scheduled tasks', `not read (${schedules.reason})`] as [string, ReactNode]] : []),
    ...(schedules.kind === 'ok' && schedules.unread > 0
      ? [['unread tasks', `${String(schedules.unread)} this page cannot read (not shown, not changed)`] as [string, ReactNode]] : []),
  ]
  const lines = said === null ? [] : [...said.timer, ...said.tasks]
  const answerLine = said === null ? null : lines.length > 0 ? lines.join(' · ') : busy ? 'Asking the host…' : 'nothing was active, so nothing was changed'
  const badge = { reading: 'READING', active: 'WAKES ACTIVE', unconfirmed: 'NOT ALL READ', paused: 'ALL WAKES PAUSED' }[state.kind]
  const tone = state.kind === 'reading' ? 'muted' : state.kind === 'paused' ? 'blue' : 'gold'
  return (
    <>
      <PortalButton
        tone={tone === 'gold' ? 'gold' : 'blue'}
        icon="agent"
        title="Wake"
        summary={wakeSummaryWords(state)}
        badge={<StatusPill tone={tone}>{badge}</StatusPill>}
      >
        {rows.length === 0 ? null : <FieldTable rows={rows} />}
        {pending === null ? null : (
          <div className="x5-wake-confirm" data-sovereignty-wake-confirm="">
            <span>
              {pending.kind === 'host'
                ? `Resume the host's wake timer? It starts waking her again, every ${everyWords(pending.intervalMs)}.`
                : `Resume "${pending.row.title}"? It starts delivering again (${pending.row.rule}).`}
            </span>
            <button type="button" className="x5-field" data-sovereignty-wake-resume-confirm="" disabled={busy} onClick={() => { resume(pending) }}>Resume</button>
            <button type="button" className="x5-field" disabled={busy} onClick={() => { setPending(null) }}>Cancel</button>
          </div>
        )}
      </PortalButton>
      {pausable || answerLine !== null ? (
        <div className="x5-wake-kill" data-sovereignty-wake-kill="">
          {pausable ? (
            <button type="button" className="x5-field" data-sovereignty-wake-pause="" disabled={busy} onClick={pauseAll}>
              {busy ? 'Asking the host…' : 'Pause every wake now'}
            </button>
          ) : null}
          {answerLine === null ? null : <span role="status" data-sovereignty-wake-answer="">{answerLine}</span>}
        </div>
      ) : null}
    </>
  )
}
