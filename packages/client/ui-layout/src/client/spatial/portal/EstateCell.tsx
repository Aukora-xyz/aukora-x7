// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE ESTATE CARD (Continuity, Wave 5): what the host says about its own estate, from `GET /_host/estate`, when a host
 * serves that route. The route is an edge seam still being built (North Star §24.2), so this card reads whatever a live
 * answer carries and draws only that: each field as a row named by its path, lists as counts, true/false flags as they
 * are, and no other value under a secret-shaped name (the Identity cards' rule, `statusRows`, and more names besides). A host
 * without the route says so in one line; a refusal shows the host's own code. Nothing here is guessed or filled in.
 * @module portal/EstateCell
 */
import { useEffect, useRef, useState } from 'react'
import { asRecord } from '../x5/rpc.ts'
import { hostCall, type HostAnswer } from '../apps/identity/host.ts'
import { FieldTable, Lead, PortalButton, StatusPill } from '../primitives/index.ts'
import { checkRecoveryAgainstEdge, recoveryCheckWords } from './recovery-restore.ts'

export const ESTATE_ROUTE = '/_host/estate'

/** Field names that are never drawn, whatever a route answers (the same rule as `statusRows`). */
const SECRET = new RegExp('secret|private|seed|password|token|cap(ability)?$|cookie|mnemonic|words?$'
  + '|(?<!pub)key$|phrase|credential|authori[sz]ation|bearer|session|sid$|pin$|code$', 'i')

/**
 * The mirror's count of stored entries the secret-path rule withholds (`mirror.withheldEntries`
 * and its plain line `mirror.pathRuleNote` from the edge). Drawn as one row in these words when it is above 0, and not
 * at all when it is 0; the edge's own line is never drawn beside it.
 */
export const WITHHELD_WORDS = 'entries withheld by the secret-path rule'

/** The deepest record this card opens, and the most rows it draws: a host's answer never grows the page without bound. */
const ESTATE_DEPTH = 3
export const ESTATE_MAX_ROWS = 96

/**
 * The rows of an estate answer (`aukora.edge-estate.v1` on the edge: head, mirror, archive, worker). Records are opened
 * into rows named by their path (`head.wake.enabled`); a list is only ever counted. A true/false flag is always drawn
 * (it can say that something is present, never what it is, so the host's secret-presence flags show). Any other value
 * under a secret-shaped name, at any depth, is never drawn. The mirror's withheld count is drawn only when above 0
 * (WITHHELD_WORDS).
 * @param body - the live answer's body.
 * @returns `[name, value]` rows, without `ok`, at most ESTATE_MAX_ROWS.
 */
export function estateRows(body: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = []
  const walk = (value: unknown, path: string, hidden: boolean, depth: number): void => {
    if (rows.length >= ESTATE_MAX_ROWS) return
    if (path === 'mirror.pathRuleNote') return
    if (path === 'mirror.withheldEntries') {
      if (!hidden && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) rows.push([path, `${WITHHELD_WORDS}: ${String(value)}`])
      return
    }
    if (typeof value === 'boolean') { rows.push([path, String(value)]); return }
    if (value === null || typeof value === 'string' || typeof value === 'number') { if (!hidden) rows.push([path, String(value)]); return }
    if (Array.isArray(value)) { if (!hidden) rows.push([path, `${String(value.length)} entries`]); return }
    if (typeof value !== 'object') return
    const record = asRecord(value)
    if (depth >= ESTATE_DEPTH) { if (!hidden) rows.push([path, `${String(Object.keys(record).length)} fields`]); return }
    // Under a secret-shaped name everything stays hidden but its true/false flags.
    for (const [key, inner] of Object.entries(record)) walk(inner, `${path}.${key}`, hidden || SECRET.test(key), depth + 1)
  }
  for (const [key, value] of Object.entries(body)) if (key !== 'ok') walk(value, key, SECRET.test(key), 1)
  return rows
}

export function EstateCell({ active, round }: { readonly active: boolean; readonly round: number }) {
  const [answer, setAnswer] = useState<HostAnswer | null>(null)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setAnswer(null)
    hostCall(ESTATE_ROUTE, controller.signal).then((next) => { if (!controller.signal.aborted) setAnswer(next) }).catch(() => {})
    return () => { controller.abort() }
  }, [active, round])
  const kind = answer?.kind ?? 'reading'
  const rows = answer?.kind === 'live' ? estateRows(answer.body) : []
  return (
    <PortalButton
      tone={kind === 'live' ? 'blue' : 'muted'}
      icon="devices"
      title="Estate"
      summary={kind === 'live' ? `${String(rows.length)} fields from ${ESTATE_ROUTE}` : `${ESTATE_ROUTE} · what this host holds`}
      badge={<StatusPill tone={kind === 'live' ? 'mint' : kind === 'refused' ? 'red' : 'muted'}>
        {kind === 'live' ? 'LIVE' : kind === 'refused' ? 'REFUSED' : kind === 'absent' ? 'NOT ON THIS HOST YET' : 'READING'}
      </StatusPill>}
    >
      <div data-continuity-estate={kind}>
        {answer === null ? <Lead>Reading the host.</Lead> : null}
        {answer?.kind === 'absent' ? <Lead>{`This host does not serve its estate yet (${answer.detail}).`}</Lead> : null}
        {answer?.kind === 'refused' ? <Lead>{`This host refused to show its estate (${answer.code}); you may be signed out.`}</Lead> : null}
        {answer?.kind === 'live' && rows.length === 0 ? <Lead>The host answered with no fields this card can draw.</Lead> : null}
        {rows.length === 0 ? null : <FieldTable rows={rows} />}
        <RecoveryCheck active={active} />
      </div>
    </PortalButton>
  )
}

/** The largest file this card reads: any snapshot an edge can make fits (four parts, the mirror at most 96 MiB). */
const RECOVERY_FILE_MAX_BYTES = 320 * 1024 * 1024

/**
 * CHECK A RECOVERY SNAPSHOT AGAINST THIS EDGE: pick the file, every part is checked against its SHA-256, then her HEAD,
 * receipts and memory here are compared with the file's. Nothing is written from this card, ever: a live edge is never
 * overwritten from a file (an empty edge shows its own Restore page).
 */
function RecoveryCheck({ active }: { readonly active: boolean }) {
  const [words, setWords] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'checking' | 'done'>('idle')
  const inFlight = useRef<AbortController | null>(null)
  useEffect(() => { if (!active) { inFlight.current?.abort(); setWords(null); setState('idle') } }, [active])
  useEffect(() => () => { inFlight.current?.abort() }, [])
  const check = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setState('checking')
    setWords(`Checking every part of ${file.name} against its SHA-256…`)
    try {
      if (file.size > RECOVERY_FILE_MAX_BYTES) { setWords('Refused: the file is larger than any snapshot an edge makes. Nothing was written.'); return }
      let parsed: unknown
      try { parsed = JSON.parse(await file.text()) } catch { setWords('Refused: the file is not JSON. Nothing was written.'); return }
      const result = await checkRecoveryAgainstEdge(parsed, controller.signal)
      if (!controller.signal.aborted) setWords(recoveryCheckWords(result))
    } catch {
      if (!controller.signal.aborted) setWords('The check did not finish. Nothing was written.')
    } finally {
      if (inFlight.current === controller) { inFlight.current = null; setState('done') }
    }
  }
  return (
    <div data-continuity-recovery-check={state}>
      <label className="x6-identity__status" htmlFor="x6-recovery-check">Check a recovery snapshot against this edge</label>
      <input id="x6-recovery-check" className="x5-field" type="file" accept="application/json,.json" disabled={state === 'checking'}
        onChange={(event) => { void check(event.target.files?.[0]); event.target.value = '' }} />
      {words === null ? null : <Lead><span role="status" data-continuity-recovery-check-words="">{words}</span></Lead>}
    </div>
  )
}
