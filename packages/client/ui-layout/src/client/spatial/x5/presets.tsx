// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The predecessor's Agent presets surface (an earlier repository), on x6.1's own DSH API.
 *
 * The roster is `agentPresets/list`; an opened card reads its declared composition with `agentPresets/read`. Setting
 * a default writes `agent-preset-registry.selectedDefault` through `settings/mutate` with the namespace's
 * `expectedRevision`. It changes which preset a NEW conversation composes; it starts nothing.
 * @module x5/presets
 */
import { useState } from 'react'
import { Lead, PortalButton, PortalCell, PortalGrid, StatusPill } from '../primitives/index.ts'
import { ErrorLine, SurfaceFrame, useDshCalls, writeSetting } from './common.tsx'
import { namespaceViews, type NamespaceView } from './general.tsx'
import { asArray, asRecord, asString, valueOf } from './rpc.ts'

/** The settings namespace the stock preset picker writes (`AGENT_PRESET_SETTINGS_NS`). */
const PRESET_NS = 'agent-preset-registry'

/** One roster row (`AgentPresetRow`). */
interface PresetRow {
  readonly id: string
  readonly isDefault: boolean
  readonly name: string | null
  readonly description: string | null
  readonly broken: string | null
}

function presetRows(roster: unknown): PresetRow[] {
  return asArray(asRecord(roster).presets).flatMap((row): PresetRow[] => {
    const record = asRecord(row)
    const id = asString(record.id)
    return id === null ? [] : [{
      id,
      isDefault: record.isDefault === true,
      name: asString(record.name),
      description: asString(record.description),
      broken: asString(record.broken),
    }]
  })
}

function PresetCard({ preset, open, writable, namespace, onToggle, reload }: {
  readonly preset: PresetRow
  readonly open: boolean
  readonly writable: boolean
  readonly namespace: NamespaceView | undefined
  readonly onToggle: (open: boolean) => void
  readonly reload: () => void
}) {
  const composition = useDshCalls([['agentPresets/read', { agentPreset: preset.id }]], open)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const content = composition.values[0] === undefined ? null : asString(asRecord(valueOf(composition.values[0])).content)
  const select = async () => {
    if (!namespace || busy) return
    setBusy(true)
    setError(null)
    try {
      await writeSetting(PRESET_NS, ['selectedDefault'], preset.id, namespace.revision)
      reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const badge = preset.isDefault
    ? <StatusPill tone="blue">DEFAULT</StatusPill>
    : preset.broken !== null ? <StatusPill tone="red">BROKEN</StatusPill> : undefined
  return (
    <PortalCell data-preset={preset.id}>
      <PortalButton tone={preset.broken !== null ? 'red' : preset.isDefault ? 'blue' : 'violet'} icon="presets"
        title={preset.name ?? preset.id} summary={preset.description ?? preset.id} badge={badge}
        expanded={open} onToggle={onToggle}>
        {preset.broken !== null ? <p className="x5-error">{preset.broken}</p> : null}
        {content !== null
          ? <pre className="x5-document">{content}</pre>
          : composition.error === null ? <Lead>Reading the declared composition.</Lead> : null}
        <div className="x5-actions">
          <button className="ak-action ak-tone-blue" type="button"
            disabled={!writable || !namespace || preset.isDefault || preset.broken !== null || busy}
            onClick={() => { void select() }}>{busy ? 'Saving…' : preset.isDefault ? 'Default for new conversations' : 'Set as default'}</button>
        </div>
        <ErrorLine error={error ?? composition.error} />
      </PortalButton>
    </PortalCell>
  )
}

/**
 * The Agent presets surface: the live roster, each preset's declared composition, and the default choice.
 * @param props - `active` while this surface is the centre Stage's selection.
 * @returns the surface (hidden and idle while inactive).
 */
export function PresetsSurface({ active }: { readonly active: boolean }) {
  const roster = useDshCalls([['agentPresets/list'], ['settings/describe']], active)
  const [open, setOpen] = useState<string | null>(null)
  const presets = roster.values[0] === undefined ? [] : presetRows(valueOf(roster.values[0]))
  const description = roster.values[1] === undefined ? undefined : asRecord(valueOf(roster.values[1]))
  const namespace = namespaceViews(description).find(row => row.ns === PRESET_NS)
  const writable = description?.writable === true
  return (
    <SurfaceFrame active={active} eyebrow="DeepSeek Harness · live preset registry" title="Agent presets" data-settings-section="agent-presets"
      badges={[{ text: roster.loaded && roster.error === null ? 'LIVE · DSH' : roster.loaded ? 'DSH REFUSED' : 'READING', tone: roster.loaded && roster.error === null ? 'mint' : 'muted' }, { text: `${String(presets.length)} PRESETS`, tone: 'violet' }]}>
      <Lead>
        Preset declarations come from this page&apos;s own DSH registry. Choosing a default writes only that registry
        setting, for conversations started afterwards; it does not start a second agent.
      </Lead>
      {roster.loaded && !namespace && !roster.error
        ? <Lead>DSH lists no {PRESET_NS} settings namespace, so the default cannot be changed here.</Lead>
        : null}
      <PortalGrid open={open !== null}>
        {presets.filter(preset => open === null || preset.id === open).map(preset => (
          <PresetCard key={preset.id} preset={preset} open={open === preset.id} writable={writable} namespace={namespace}
            onToggle={(next) => { setOpen(next ? preset.id : null) }} reload={roster.reload} />
        ))}
      </PortalGrid>
      {!roster.loaded && active ? <Lead>Reading the preset roster from DSH.</Lead> : null}
      {roster.loaded && presets.length === 0 && !roster.error ? <Lead>DSH returned no agent presets.</Lead> : null}
      <ErrorLine error={roster.error} />
    </SurfaceFrame>
  )
}
