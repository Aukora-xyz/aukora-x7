// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The predecessor's Models surface (an earlier repository), on x6.1's own DSH API.
 *
 * The provider directory is `llm/listConfigurableProviders` joined with the live routes of `llm/listProviders`; the
 * models each route serves come from `session/modelCatalog`; each route's profile and revision come from
 * `settings/describe`; key state comes from `credentials/describe`, which answers configured / not configured and
 * never a value. The only write is a route's endpoint, through `settings/mutate` with `expectedRevision`. This
 * surface neither reads nor writes key values.
 * @module x5/models
 */
import { useState } from 'react'
import { FieldTable, Lead, RecordList, RecordRow, StatusPill } from '../primitives/index.ts'
import { ErrorLine, SurfaceFrame, useDshCalls, valueAt, writeSetting } from './common.tsx'
import { namespaceViews, type NamespaceView } from './general.tsx'
import { asArray, asRecord, asString, valueOf } from './rpc.ts'

/** The credential reference grammar `credentials/describe` accepts (a POSIX shell identifier). */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** `credentials/describe` refuses a batch larger than this. */
const MAX_DESCRIBE_REFS = 64

/** One provider route as this surface shows it. */
interface ProviderEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  /** Whether `llm/listProviders` reports the route registered (live). */
  readonly live: boolean
  readonly defaultBaseURL: string | null
  readonly nativeEnv: readonly string[]
  readonly nativeOauth: boolean
  readonly error: string | null
}

/** One catalog group: the models a live route serves. */
interface CatalogGroup {
  readonly id: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

const strings = (value: unknown): string[] => asArray(value).flatMap(item => (typeof item === 'string' ? [item] : []))

/**
 * The stock page's derived key reference for a route that names none (`deriveKeyRef` in ui-settings-models).
 * @param provider - provider route id.
 * @returns e.g. `MINIMAX_CN_API_KEY`.
 */
function derivedRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** The key reference a route's resolved profile names (`apiKeyEnv`), else the derived one. */
function credentialRef(entry: ProviderEntry, namespace: NamespaceView | undefined): string {
  const named = valueAt(namespace?.value, [...entry.settingsPath, 'apiKeyEnv'])
  return typeof named === 'string' && named.length > 0 ? named : derivedRef(entry.provider)
}

/** Join the configurable directory with the registered routes (a registered route with no directory entry still shows). */
function providerEntries(configurable: unknown, registered: unknown): ProviderEntry[] {
  const liveIds = new Set(asArray(registered).flatMap(row => strings([asRecord(row).id])))
  const entries: ProviderEntry[] = asArray(configurable).flatMap((row): ProviderEntry[] => {
    const record = asRecord(row)
    const provider = asString(record.provider)
    if (provider === null) return []
    const native = asRecord(record.nativeAuth)
    return [{
      provider,
      displayName: asString(record.displayName) ?? provider,
      settingsNs: asString(record.settingsNs) ?? '',
      settingsPath: strings(record.settingsPath),
      live: liveIds.has(provider),
      defaultBaseURL: asString(record.defaultBaseURL),
      nativeEnv: strings(native.env),
      nativeOauth: native.oauth === true,
      error: asString(record.error),
    }]
  })
  const known = new Set(entries.map(entry => entry.provider))
  for (const row of asArray(registered)) {
    const record = asRecord(row)
    const id = asString(record.id)
    if (id === null || known.has(id)) continue
    entries.push({
      provider: id, displayName: asString(record.name) ?? id, settingsNs: '', settingsPath: [], live: true,
      defaultBaseURL: null, nativeEnv: [], nativeOauth: false, error: null,
    })
  }
  return entries
}

function catalogGroups(catalog: unknown): CatalogGroup[] {
  return asArray(asRecord(catalog).groups).flatMap((row): CatalogGroup[] => {
    const record = asRecord(row)
    const id = asString(record.id)
    if (id === null) return []
    const models = asArray(record.models).flatMap((model) => {
      const m = asRecord(model)
      const modelId = asString(m.id)
      return modelId === null ? [] : [{ id: modelId, name: asString(m.name) ?? modelId }]
    })
    return [{ id, models }]
  })
}

/** Model ids a route's stored profile lists (`models: [{ id }]` or plain ids), when its catalog has none. */
function profileModels(profile: unknown): string[] {
  return asArray(asRecord(profile).models).flatMap((row) => {
    if (typeof row === 'string') return [row]
    const id = asString(asRecord(row).id)
    return id === null ? [] : [id]
  })
}

function ProviderCard({ entry, namespace, credential, catalog, failure, isDefault, writable, reload }: {
  readonly entry: ProviderEntry
  readonly namespace: NamespaceView | undefined
  readonly credential: Record<string, unknown> | undefined
  readonly catalog: CatalogGroup | undefined
  readonly failure: string | null
  readonly isDefault: string | null
  readonly writable: boolean
  readonly reload: () => void
}) {
  const profile = valueAt(namespace?.value, entry.settingsPath)
  const hasProfile = profile !== null && typeof profile === 'object' && !Array.isArray(profile)
  const storedBaseURL = asString(asRecord(profile).baseURL) ?? ''
  const ref = credentialRef(entry, namespace)
  const [baseURL, setBaseURL] = useState(storedBaseURL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const configured = credential?.configured === true
  const described = credential !== undefined
  const keyless = entry.nativeOauth || entry.nativeEnv.length > 0
  const models = catalog !== undefined && catalog.models.length > 0
    ? catalog.models.map(model => model.name).join(' · ')
    : profileModels(profile).join(' · ') || 'Adapter defaults'
  const canEditEndpoint = entry.settingsNs !== '' && hasProfile && namespace !== undefined

  const saveEndpoint = async () => {
    if (busy || namespace === undefined) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await writeSetting(entry.settingsNs, [...entry.settingsPath, 'baseURL'], baseURL.trim(), namespace.revision, baseURL.trim() === '')
      setNotice(baseURL.trim() === '' ? 'Endpoint override removed through DSH.' : 'Endpoint saved through DSH.')
      reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const keyPill = !described
    ? <StatusPill tone="muted">KEY UNKNOWN</StatusPill>
    : configured ? <StatusPill tone="mint">KEY CONFIGURED</StatusPill> : <StatusPill tone="muted">NO KEY</StatusPill>
  return (
    <RecordRow tone={entry.error !== null ? 'red' : entry.live ? 'mint' : 'muted'} title={entry.displayName}
      summary={`${entry.provider} · ${models}`}
      status={<>
        {isDefault !== null ? <StatusPill tone="blue">DEFAULT</StatusPill> : null}
        <StatusPill tone={entry.live ? 'mint' : 'muted'}>{entry.live ? 'LIVE ROUTE' : 'DORMANT'}</StatusPill>
        {keyPill}
      </>}>
      <FieldTable rows={[
        ['provider', entry.provider],
        ['route', entry.live ? 'registered (llm/listProviders)' : 'not registered'],
        ['namespace', entry.settingsNs || 'registered route'],
        ['settings path', entry.settingsPath.join(' / ') || (entry.settingsNs ? 'whole section' : 'route owned')],
        ['models', models],
        ...(isDefault !== null ? [['default model', isDefault] as const] : []),
        ['endpoint', storedBaseURL || entry.defaultBaseURL || 'adapter default'],
        ['credential reference', ref],
        ['key', !described ? 'not described' : configured ? 'configured' : 'not configured'],
        ...(configured && asString(credential?.source) !== null ? [['key source', String(credential?.source)] as const] : []),
        ...(keyless ? [['native auth', [...entry.nativeEnv, ...entry.nativeOauth ? ['OAuth sign-in'] : []].join(' · ')] as const] : []),
        ...(failure !== null ? [['catalog', failure] as const] : []),
        ...(entry.error !== null ? [['diagnostic', entry.error] as const] : []),
      ]} />
      {canEditEndpoint
        ? <>
          <label className="ak-label">Endpoint (base URL)
            <input className="x5-field" value={baseURL} disabled={!writable || busy} placeholder={entry.defaultBaseURL ?? ''}
              onChange={(event) => { setBaseURL(event.currentTarget.value); setError(null); setNotice(null) }} />
          </label>
          <div className="x5-actions">
            <button className="ak-action ak-tone-blue" type="button" disabled={!writable || busy || baseURL.trim() === storedBaseURL}
              onClick={() => { void saveEndpoint() }}>{busy ? 'Saving…' : 'Save endpoint'}</button>
          </div>
        </>
        : null}
      {notice ? <p className="x5-notice" role="status">{notice}</p> : null}
      <ErrorLine error={error} />
    </RecordRow>
  )
}

/**
 * The Models surface: every provider route, its models, endpoint and key state (configured or not, never the value).
 * @param props - `active` while this surface is the centre Stage's selection.
 * @returns the surface (hidden and idle while inactive).
 */
export function ModelsSurface({ active }: { readonly active: boolean }) {
  const directory = useDshCalls([['llm/listProviders'], ['llm/listConfigurableProviders'], ['settings/describe']], active)
  const catalogCall = useDshCalls([['session/modelCatalog']], active)
  const description = directory.values[2] === undefined ? undefined : asRecord(valueOf(directory.values[2]))
  const namespaces = namespaceViews(description)
  const entries = providerEntries(
    directory.values[1] === undefined ? [] : valueOf(directory.values[1]),
    directory.values[0] === undefined ? [] : valueOf(directory.values[0]),
  )
  const namespaceOf = (entry: ProviderEntry) => namespaces.find(row => row.ns === entry.settingsNs)
  const refs = [...new Set(entries.map(entry => credentialRef(entry, namespaceOf(entry))))]
    .filter(ref => REF_PATTERN.test(ref)).slice(0, MAX_DESCRIBE_REFS)
  const credentials = useDshCalls([['credentials/describe', { refs }]], active && refs.length > 0)
  const credentialValues = credentials.values[0] === undefined ? {} : asRecord(valueOf(credentials.values[0]))
  const catalog = catalogCall.values[0] === undefined ? {} : asRecord(valueOf(catalogCall.values[0]))
  const groups = catalogGroups(catalog)
  const failures = new Map(asArray(catalog.failures).flatMap((row) => {
    const record = asRecord(row)
    const id = asString(record.id)
    return id === null ? [] : [[id, asString(record.message) ?? 'catalog lookup failed'] as const]
  }))
  const defaults = asRecord(catalog.default)
  const reload = () => { directory.reload(); catalogCall.reload(); credentials.reload() }
  const liveCount = entries.filter(entry => entry.live).length
  const configuredCount = Object.values(credentialValues).filter(info => asRecord(info).configured === true).length

  return (
    <SurfaceFrame active={active} eyebrow="DeepSeek Harness · provider directory" title="Models" data-settings-section="models"
      badges={[
        { text: directory.loaded && directory.error === null ? 'LIVE · DSH' : directory.loaded ? 'DSH REFUSED' : 'READING', tone: directory.loaded && directory.error === null ? 'mint' : 'muted' },
        { text: `${String(liveCount)} LIVE ROUTES`, tone: liveCount > 0 ? 'mint' : 'muted' },
        { text: `${String(configuredCount)} KEYS`, tone: configuredCount > 0 ? 'blue' : 'muted' },
      ]}>
      <Lead>
        Providers, models, endpoints and key state come from this page&apos;s own DSH host. A key shows only as configured
        or not configured: this surface never reads or writes a key value.
      </Lead>
      <RecordList>
        {entries.map((entry) => {
          const namespace = namespaceOf(entry)
          const info = credentialValues[credentialRef(entry, namespace)]
          return (
            <ProviderCard key={entry.provider} entry={entry} namespace={namespace}
              credential={info === undefined ? undefined : asRecord(info)}
              catalog={groups.find(group => group.id === entry.provider)}
              failure={failures.get(entry.provider) ?? null}
              isDefault={asString(defaults.provider) === entry.provider ? asString(defaults.model) : null}
              writable={description?.writable === true} reload={reload} />
          )
        })}
      </RecordList>
      {!directory.loaded && active ? <Lead>Reading the provider directory from DSH.</Lead> : null}
      {directory.loaded && entries.length === 0 && !directory.error ? <Lead>DSH returned no provider routes.</Lead> : null}
      <ErrorLine error={directory.error ?? catalogCall.error ?? credentials.error} />
    </SurfaceFrame>
  )
}
