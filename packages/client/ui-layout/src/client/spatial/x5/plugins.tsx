// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The predecessor's Built-in plugins surface (an earlier repository), on x6.1's own DSH API.
 *
 * Read-only. Loader plugins and per-preset compositions come from `pluginInventory/list`; skills come from
 * `skills/list` for the conversation on screen (DSH lists skills per conversation). One search filters all three,
 * and every card opens in place. The predecessor's version also listed the X5 world's staged Spatial seed files from its
 * `X5LiveState`; x6.1 serves no such manifest, so that section says NOT CONNECTED YET.
 * @module x5/plugins
 */
import { useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DetailSection, FieldTable, Lead, PortalButton, PortalCell, PortalGrid, StatusPill, type Tone } from '../primitives/index.ts'
import { ErrorLine, SurfaceFrame, useDshCalls } from './common.tsx'
import { asArray, asRecord, asString, valueOf } from './rpc.ts'

/** A localized display text (`string | { en, … }`), as plain text. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  return asString(record.en) ?? Object.values(record).find((item): item is string => typeof item === 'string') ?? null
}

/** A package icon only when it is an image data URL (render as an image, never as markup). */
function iconOf(meta: Record<string, unknown>): ReactNode | undefined {
  const icon = asString(meta.icon)
  return icon !== null && icon.startsWith('data:image/') ? <img src={icon} alt="" width={18} height={18} /> : undefined
}

const matches = (query: string, ...fields: readonly (string | null | undefined)[]) =>
  query === '' || fields.some(field => typeof field === 'string' && field.toLowerCase().includes(query))

/** One card: a PortalButton that opens in place, controlled by the surface so only one is open at a time. */
function Card({ id, open, onToggle, tone, icon, title, summary, badge, children }: {
  readonly id: string
  readonly open: string | null
  readonly onToggle: (id: string | null) => void
  readonly tone: Tone
  readonly icon: ReactNode
  readonly title: string
  readonly summary: string
  readonly badge?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <PortalCell data-plugin-card={id}>
      <PortalButton tone={tone} icon={icon} title={title} summary={summary} badge={badge} expanded={open === id}
        onToggle={(next) => { onToggle(next ? id : null) }}>
        {children}
      </PortalButton>
    </PortalCell>
  )
}

function phaseTone(enabled: unknown, phase: unknown, diagnostic: string | null): Tone {
  if (diagnostic !== null || phase === 'failed') return 'red'
  if (enabled === false) return 'muted'
  if (enabled === 'conditional') return 'gold'
  return phase === 'active' ? 'mint' : 'blue'
}

function phaseLabel(enabled: unknown, phase: unknown): string {
  if (enabled === false) return 'DISABLED'
  if (enabled === 'conditional') return 'CONDITIONAL'
  return typeof phase === 'string' ? phase.toUpperCase() : 'NOT RUNNING'
}

/**
 * The Built-in plugins surface: running Loader plugins, preset compositions and skills, searchable, opening inline.
 * @param props - `active` while this surface is the centre Stage's selection; `sessionId` is the conversation on
 *   screen, whose skills DSH lists (undefined when none is open).
 * @returns the surface (hidden and idle while inactive).
 */
export function PluginsSurface({ active, sessionId }: { readonly active: boolean; readonly sessionId: SessionId | undefined }) {
  const inventoryCall = useDshCalls([['pluginInventory/list']], active)
  const skillsCall = useDshCalls([['skills/list', { request: { sessionId: sessionId ?? '' } }]], active && sessionId !== undefined)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const query = search.trim().toLowerCase()

  const inventory = inventoryCall.values[0] === undefined ? {} : asRecord(valueOf(inventoryCall.values[0]))
  const entries = asArray(inventory.entries).map(asRecord)
  const presets = asArray(inventory.agentPresets).map(asRecord)
  const skills = skillsCall.values[0] === undefined || sessionId === undefined
    ? [] : asArray(asRecord(valueOf(skillsCall.values[0])).skills).map(asRecord)

  const shownEntries = entries.filter((entry) => {
    const meta = asRecord(entry.meta)
    return matches(query, asString(entry.entryId), asString(entry.moduleName), text(meta.title), text(meta.description))
  })
  const shownPresets = presets.filter(preset => matches(query, asString(preset.id), asString(preset.name),
    ...asArray(preset.rows).map(row => asString(asRecord(row).moduleName))))
  const shownSkills = skills.filter(skill => matches(query, asString(skill.name), asString(skill.description), asString(skill.whenToUse)))
  const running = entries.filter(entry => entry.fiberPhase === 'active').length

  return (
    <SurfaceFrame active={active} eyebrow="DeepSeek Harness · live inventory" title="Built-in plugins" data-settings-section="plugins"
      badges={[
        { text: inventoryCall.loaded && inventoryCall.error === null ? 'LIVE · DSH' : inventoryCall.loaded ? 'DSH REFUSED' : 'READING', tone: inventoryCall.loaded && inventoryCall.error === null ? 'mint' : 'muted' },
        { text: `${String(running)}/${String(entries.length)} RUNNING`, tone: running > 0 ? 'mint' : 'muted' },
        { text: `${String(skills.length)} SKILLS`, tone: skills.length > 0 ? 'violet' : 'muted' },
      ]}
      headerBelow={
        <input className="x5-field" type="search" value={search} placeholder="Search plugins and skills" aria-label="Search plugins and skills"
          onChange={(event) => { setSearch(event.currentTarget.value); setOpen(null) }} />
      }>
      <DetailSection label={`Running DSH plugins · ${String(shownEntries.length)}${query ? ` of ${String(entries.length)}` : ''}`}>
        <PortalGrid open={false}>
          {shownEntries.map((entry, index) => {
            const meta = asRecord(entry.meta)
            const id = asString(entry.entryId) ?? `entry-${String(index)}`
            const moduleName = asString(entry.moduleName) ?? id
            const diagnostic = asString(entry.diagnostic)
            const tone = phaseTone(entry.enabled, entry.fiberPhase, diagnostic)
            return (
              <Card key={id} id={`plugin:${id}`} open={open} onToggle={setOpen} tone={tone} icon={iconOf(meta) ?? 'plugins'}
                title={text(meta.title) ?? moduleName} summary={text(meta.description) ?? moduleName}
                badge={<StatusPill tone={tone}>{diagnostic !== null ? 'FAILED' : phaseLabel(entry.enabled, entry.fiberPhase)}</StatusPill>}>
                <FieldTable rows={[
                  ['entry', id],
                  ['module', moduleName],
                  ['enabled', entry.enabled === true ? 'yes' : 'no'],
                  ['phase', asString(entry.fiberPhase) ?? 'no live fiber'],
                  ...(text(meta.description) !== null ? [['about', text(meta.description)] as const] : []),
                  ...(diagnostic !== null ? [['diagnostic', diagnostic] as const] : []),
                  ...(asString(meta.error) !== null ? [['metadata', asString(meta.error)] as const] : []),
                ]} />
              </Card>
            )
          })}
        </PortalGrid>
        {inventoryCall.loaded && entries.length === 0 && !inventoryCall.error ? <Lead>DSH returned no plugin entries.</Lead> : null}
        {!inventoryCall.loaded && active ? <Lead>Reading the plugin inventory from DSH.</Lead> : null}
        <ErrorLine error={inventoryCall.error} />
      </DetailSection>

      {presets.length > 0
        ? <DetailSection label={`Agent preset compositions · ${String(shownPresets.length)}`}>
          <PortalGrid open={false}>
            {shownPresets.map((preset, index) => {
              const id = asString(preset.id) ?? `preset-${String(index)}`
              const rows = asArray(preset.rows).map(asRecord)
              const broken = asString(preset.broken)
              return (
                <Card key={id} id={`preset:${id}`} open={open} onToggle={setOpen} tone={broken !== null ? 'red' : 'violet'} icon="presets"
                  title={asString(preset.name) ?? id} summary={broken ?? `${String(rows.length)} plugin rows`}
                  badge={preset.isDefault === true ? <StatusPill tone="blue">DEFAULT</StatusPill> : undefined}>
                  <FieldTable rows={rows.map((row, rowIndex) => {
                    const meta = asRecord(row.meta)
                    const name = text(meta.title) ?? asString(row.moduleName) ?? `row ${String(rowIndex + 1)}`
                    const state = phaseLabel(row.enabled, row.fiberPhase)
                    const condition = asString(row.condition)
                    return [name, `${asString(row.moduleName) ?? ''} · ${state}${condition !== null ? ` · when ${condition}` : ''}`] as const
                  })} />
                  {broken !== null ? <p className="x5-error">{broken}</p> : null}
                </Card>
              )
            })}
          </PortalGrid>
        </DetailSection>
        : null}

      <DetailSection label={`Skills · ${String(shownSkills.length)}`}>
        {sessionId === undefined
          ? <Lead>DSH lists skills per conversation. Open a conversation and its skills appear here.</Lead>
          : <PortalGrid open={false}>
            {shownSkills.map((skill, index) => {
              const name = asString(skill.name) ?? `skill-${String(index)}`
              const description = asString(skill.description) ?? ''
              const whenToUse = asString(skill.whenToUse)
              const path = asString(skill.path)
              return (
                <Card key={name} id={`skill:${name}`} open={open} onToggle={setOpen} tone="violet" icon="general" title={`/${name}`}
                  summary={description}
                  badge={<StatusPill tone={skill.modelInvocable === true ? 'mint' : 'muted'}>{skill.modelInvocable === true ? 'MODEL + YOU' : 'YOU ONLY'}</StatusPill>}>
                  <FieldTable rows={[
                    ['name', name],
                    ['description', description],
                    ...(whenToUse !== null ? [['when to use', whenToUse] as const] : []),
                    ...(path !== null ? [['file', path] as const] : []),
                    ['model can invoke', skill.modelInvocable === true ? 'yes' : 'no'],
                  ]} />
                </Card>
              )
            })}
          </PortalGrid>}
        {sessionId !== undefined && skillsCall.loaded && skills.length === 0 && !skillsCall.error
          ? <Lead>DSH returned no skills for this conversation.</Lead>
          : null}
        <ErrorLine error={sessionId === undefined ? null : skillsCall.error} />
      </DetailSection>

      <DetailSection label="Spatial seed files">
        <p className="ak-lead">
          <StatusPill tone="muted">NOT CONNECTED YET</StatusPill>{' '}
          The X5 build listed its world&apos;s staged Spatial seed files (paths, sizes, hashes) here. x6.1 serves no
          seed manifest to this page, so there is nothing to list.
        </p>
      </DetailSection>
    </SurfaceFrame>
  )
}
