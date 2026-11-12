// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PREDECESSOR'S MEDIA STUDIO IN THE CENTRE STAGE (an earlier repository mounting
 * an earlier repository): the image / video switch, the prompt, the model, aspect ratio, resolution,
 * duration and audio controls, the preview frame at the chosen ratio, the gallery and the connector state.
 *
 * WHAT IS REAL. Every control works and keeps its draft on this page. Nothing is generated: x6.1 has no Higgsfield
 * connector, so Generate is disabled and says so, the gallery is empty (no sample images), and the connector's key
 * fields stay closed. The predecessor's settings were a modal `<dialog>`; here they open inline in the Stage, below the
 * header, and nothing is drawn over the site.
 *
 * MEDIA AND DOCUMENTS. The app opens on Drive, her own little drive (`DriveView.tsx`): her
 * screenshots, documents, images and videos, read only, with a preview and a Download. The predecessor's studio stays one tap away
 * under Studio, unchanged. A chat link opens the drive at a file through the surface target `drive:<n>:<path>`.
 *
 * @module apps/media/MediaSurface
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ActionControl, AppHeader, AppSurface, Panel, RecordList, RecordRow, SectionHeader, StatusPill } from '../../primitives/index.ts'
import type { Badge } from '../../primitives/index.ts'
import { workBridge } from '../../work/bridge.ts'
import { sessionOf } from '../../work/WorkSurface.tsx'
import { parseDriveTarget } from './drive-rule.ts'
import { createDriveSource, homeSessionOf, type DriveFiles, type DriveFilesDoor, type MediaSurfaceInjected } from './drive-source.ts'
import { DriveView } from './DriveView.tsx'
import { isEditableTarget } from './editable-target.ts'
import { MEDIA_MISSING, t } from './locales.ts'
import { MediaIcon } from './MediaIcon.tsx'
import css from './MediaStudio.module.css'

/** Surface id in the centre lane (the triangle menu's `media` entry). */
export const MEDIA_SURFACE = 'media'

type Mode = 'image' | 'video'
/** Media's two views: her drive (the default) and the predecessor's studio. */
type View = 'drive' | 'studio'
const VIEWS: readonly View[] = ['drive', 'studio']
const IMAGE_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '7:9', '9:7', '9:16', '16:9', '21:9']
const VIDEO_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p', '4k']
const DURATIONS = Array.from({ length: 12 }, (_, index) => index + 4)
/** The predecessor's one model per mode; there is no catalogue to read without a connector. */
const MODELS: Record<Mode, { readonly id: string; readonly name: string }> = {
  image: { id: 'z-image-turbo', name: 'Z-Image Turbo' },
  video: { id: 'seedance2', name: 'Seedance 2.0' },
}
/**
 * NOT CONNECTED YET names the predecessor's studio's generation connector (Higgsfield, `MEDIA_MISSING`), so the header shows it only
 * while Studio is open. The drive reads her files through her own worker and needs no connector: on Drive the chip would
 * say something untrue about a drive that works.
 */
const BADGES: readonly Badge[] = [{ text: 'NOT CONNECTED YET', tone: 'muted', title: `Not connected yet: ${MEDIA_MISSING}` }]
const NO_BADGES: readonly Badge[] = []
const NOT_CONNECTED = <StatusPill tone="muted" title={MEDIA_MISSING}>NOT CONNECTED YET</StatusPill>

/** The connector panel, inline under the header. The key fields are closed: there is nowhere to keep a key. */
function ConnectorSettings({ onDismiss }: { readonly onDismiss: () => void }) {
  const id = useId()
  return (
    <Panel className={css.settingsPanel} data-media-settings="">
      <SectionHeader className={css.settingsHeader}>
        <span className={css.gold}><MediaIcon kind="settings" /></span>
        <h3>{t('media.settings')}</h3>
        <ActionControl tone="gold" aria-label={t('media.closeSettings')} onClick={onDismiss}><MediaIcon kind="close" /></ActionControl>
      </SectionHeader>
      <form autoComplete="off" onSubmit={(event) => { event.preventDefault() }}>
        <div className={css.settingsFields}>
          <label className={css.field}>{t('media.keyId')}
            <input type="text" disabled defaultValue="" autoComplete="off" aria-describedby={`${id}-reason`} />
          </label>
          <label className={css.field}>{t('media.keySecret')}
            <input type="password" disabled defaultValue="" autoComplete="new-password" aria-describedby={`${id}-reason`} />
          </label>
        </div>
        <p id={`${id}-reason`} className={css.settingsReason}>{t('media.credentialsUnavailable')}</p>
        <div className={css.settingsActions}>
          <ActionControl tone="mint" disabled aria-describedby={`${id}-reason`}>{t('media.saveConnect')}</ActionControl>
        </div>
      </form>
    </Panel>
  )
}

const NO_DOOR = { subscribe: () => () => {}, current: () => null }

type SessionsHook = PropsRuntime<'shell.surface'>['useSessions']

/** A chat link's target as the drive gets it: the target, whether this Media has handled it, and who to tell. */
interface DriveTarget {
  readonly target: string | undefined
  readonly targetIsNew: boolean
  readonly onTargetHandled: (target: string) => void
}

/** The drive over the page bridge and the files service, reading through the shown thread and her home thread. */
function DriveMount({ files, link, sessionId, homeSessionId }: {
  readonly files: DriveFiles | null
  readonly link: DriveTarget
  readonly sessionId: SessionId | undefined
  readonly homeSessionId: SessionId | undefined
}) {
  const ids = useRef({ sessionId, homeSessionId })
  ids.current = { sessionId, homeSessionId }
  const callTool = workBridge()?.callTool ?? null
  const source = useMemo(() => createDriveSource({
    callTool, files, sessionId: () => ids.current.sessionId, homeSessionId: () => ids.current.homeSessionId,
  }), [callTool, files])
  return <DriveView source={source} target={link.target} targetIsNew={link.targetIsNew} onTargetHandled={link.onTargetHandled} />
}

/** The same, with the shell's threads (only rendered when the frame hands Media its sessions hook). */
function DriveWithSessions({ useSessions, files, link }: {
  readonly useSessions: SessionsHook
  readonly files: DriveFiles | null
  readonly link: DriveTarget
}) {
  const sessionId = useSessions(sessionOf)
  const homeSessionId = useSessions(homeSessionOf)
  return <DriveMount files={files} link={link} sessionId={sessionId} homeSessionId={homeSessionId} />
}

/**
 * Media and Documents, active while the centre lane shows `media`: her drive, and the predecessor's studio.
 * @param props - the centre-lane owner share, and the files door its registration may inject.
 * @returns the surface (empty while another surface is active).
 */
export function MediaSurface(props: PropsRuntime<'shell.surface'> & Partial<MediaSurfaceInjected>) {
  const { activeSurface, closeSurface } = props
  const surfaceTarget = (props as { readonly surfaceTarget?: unknown }).surfaceTarget
  const useSessions = (props as { readonly useSessions?: SessionsHook }).useSessions
  const door: DriveFilesDoor | typeof NO_DOOR = props.driveFiles ?? NO_DOOR
  const files = useSyncExternalStore(door.subscribe, door.current, door.current)
  const target = typeof surfaceTarget === 'string' ? surfaceTarget : undefined
  const active = activeSurface === MEDIA_SURFACE
  const driveTab = useRef<HTMLButtonElement>(null)
  const studioTab = useRef<HTMLButtonElement>(null)
  const [view, setView] = useState<View>('drive')
  // THE LAST CHAT TARGET THE DRIVE HANDLED. Kept here, per Media, because the drive is mounted again on
  // every Studio -> Drive while the target stays in the frame's store: a handled target only restores its selection.
  const [handledTarget, setHandledTarget] = useState<string | undefined>(undefined)
  const link: DriveTarget = { target, targetIsNew: target !== undefined && target !== handledTarget, onTargetHandled: setHandledTarget }
  const imageTab = useRef<HTMLButtonElement>(null)
  const videoTab = useRef<HTMLButtonElement>(null)
  const id = useId()
  const [mode, setMode] = useState<Mode>('image')
  const [drafts, setDrafts] = useState<Readonly<Record<Mode, string>>>({ image: '', video: '' })
  const [imageRatio, setImageRatio] = useState('1:1')
  const [videoRatio, setVideoRatio] = useState('16:9')
  const [videoResolution, setVideoResolution] = useState('1080p')
  const [duration, setDuration] = useState(8)
  const [audio, setAudio] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const video = mode === 'video'
  const ratio = video ? videoRatio : imageRatio
  const [width = 1, height = 1] = ratio.split(':').map(Number)
  const model = MODELS[mode]

  // A chat link to a file opens the drive, whichever view was showing.
  useEffect(() => {
    if (target !== undefined && parseDriveTarget(target) !== null) setView('drive')
  }, [target])

  useEffect(() => {
    if (!active) {
      setSettingsOpen(false)
      return
    }
    // Escape closes the inline settings first, then the surface; never while a text-entry control has it.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || isEditableTarget(event.target)) return
      event.preventDefault()
      if (settingsOpen) setSettingsOpen(false)
      else closeSurface()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [active, closeSurface, settingsOpen])

  if (!active) return <AppSurface active={false}>{null}</AppSurface>

  const selectMode = (next: Mode, focus = false): void => {
    setMode(next)
    if (focus) (next === 'image' ? imageTab : videoTab).current?.focus()
  }
  const selectView = (next: View, focus = false): void => {
    setView(next)
    if (focus) (next === 'drive' ? driveTab : studioTab).current?.focus()
  }

  return (
    // The x5 frame (`x5/common.tsx` SurfaceFrame) draws header tools in an absolutely positioned box over the badges, so
    // Media composes the same frame with the header's own `actions` slot: Settings follows NOT CONNECTED YET in the
    // header's flow (spec 5). Same section marks, same `.x5-app-header` band.
    <AppSurface active data-settings-surface="" data-media-studio="">
      <div className="x5-app-header">
        <AppHeader eyebrow={t('media.eyebrow')} title={t('media.name')} badges={view === 'studio' ? BADGES : NO_BADGES} actions={(
          <ActionControl tone="gold" aria-pressed={settingsOpen} aria-expanded={settingsOpen}
            onClick={() => { setSettingsOpen(open => !open) }}>
            <MediaIcon kind="settings" />{t('media.settings')}
          </ActionControl>
        )} />
      </div>
      <div className={css.studio}>
        {settingsOpen ? <ConnectorSettings onDismiss={() => { setSettingsOpen(false) }} /> : null}
        <div className={css.modeSwitch} role="tablist" aria-label={t('drive.views')}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            selectView(event.key === 'Home' ? 'drive' : event.key === 'End' ? 'studio' : view === 'drive' ? 'studio' : 'drive', true)
          }}>
          {VIEWS.map(value => (
            <ActionControl key={value} controlRef={value === 'drive' ? driveTab : studioTab} role="tab" id={`${id}-${value}-view`}
              aria-selected={view === value} aria-controls={`${id}-view`} tabIndex={view === value ? 0 : -1}
              aria-pressed={view === value} tone={value === 'drive' ? 'blue' : 'violet'} data-media-view={value}
              onClick={() => { selectView(value) }}>
              <MediaIcon kind={value === 'drive' ? 'folder' : 'image'} />{t(value === 'drive' ? 'drive.tab' : 'drive.studio')}
            </ActionControl>
          ))}
        </div>
        <div id={`${id}-view`} role="tabpanel" aria-labelledby={`${id}-${view}-view`}>
          {view === 'drive' ? (
            typeof useSessions === 'function'
              ? <DriveWithSessions useSessions={useSessions} files={files} link={link} />
              : <DriveMount files={files} link={link} sessionId={undefined} homeSessionId={undefined} />
          ) : <>
            <RecordList>
              <RecordRow tone="muted" title={t('media.connector')} summary={MEDIA_MISSING} status={NOT_CONNECTED} />
            </RecordList>
            <div className={css.workspace}>
              <Panel className={css.composer}>
                <div className={css.modeSwitch} role="tablist" aria-label={t('media.mode')}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    selectMode(event.key === 'Home' ? 'image' : event.key === 'End' ? 'video' : video ? 'image' : 'video', true)
                  }}>
                  {(['image', 'video'] as const).map(value => (
                    <ActionControl key={value} controlRef={value === 'image' ? imageTab : videoTab} role="tab" id={`${id}-${value}-tab`}
                      aria-selected={mode === value} aria-controls={`${id}-editor`} tabIndex={mode === value ? 0 : -1}
                      aria-pressed={mode === value} tone={value === 'image' ? 'blue' : 'violet'} onClick={() => { selectMode(value) }}>
                      <MediaIcon kind={value} />{t(value === 'image' ? 'media.image' : 'media.video')}
                    </ActionControl>
                  ))}
                </div>
                <div id={`${id}-editor`} role="tabpanel" aria-labelledby={`${id}-${mode}-tab`} className={css.editor}>
                  <label className={css.promptLabel} htmlFor={`${id}-prompt`}>{t('media.prompt')}</label>
                  <textarea id={`${id}-prompt`} className={css.prompt} rows={5} value={drafts[mode]}
                    maxLength={video ? 4000 : 800} placeholder={t(video ? 'media.videoPlaceholder' : 'media.imagePlaceholder')}
                    onChange={(event) => {
                      const text = event.currentTarget.value
                      setDrafts(previous => ({ ...previous, [mode]: text }))
                    }} />
                  <div className={css.controls}>
                    <label className={`${css.field} ${css.model}`}>{t('media.model')}
                      <select value={model.id} onChange={() => {}}>
                        <option value={model.id}>{model.name}</option>
                      </select>
                    </label>
                    <label className={css.field}>{t('media.ratio')}
                      <select value={ratio} onChange={(event) => { (video ? setVideoRatio : setImageRatio)(event.currentTarget.value) }}>
                        {(video ? VIDEO_RATIOS : IMAGE_RATIOS).map(value => <option key={value}>{value}</option>)}
                      </select>
                    </label>
                    <label className={css.field}>{t('media.resolution')}
                      <select value={video ? videoResolution : '1k'}
                        onChange={(event) => { if (video) setVideoResolution(event.currentTarget.value) }}>
                        {(video ? VIDEO_RESOLUTIONS : ['1k']).map(value => <option key={value}>{value}</option>)}
                      </select>
                    </label>
                    {video && (
                      <label className={css.field}>{t('media.duration')}
                        <select value={duration} onChange={(event) => { setDuration(Number(event.currentTarget.value)) }}>
                          {DURATIONS.map(value => <option key={value} value={value}>{value} s</option>)}
                        </select>
                      </label>
                    )}
                    {video && (
                      <label className={css.audio}>{t('media.audio')}
                        <input type="checkbox" role="switch" checked={audio} onChange={(event) => { setAudio(event.currentTarget.checked) }} />
                      </label>
                    )}
                  </div>
                </div>
                <div className={css.generateArea}>
                  <ActionControl className={css.generate} tone="mint" disabled aria-describedby={`${id}-unavailable`}>
                    <MediaIcon kind="lock" />{t('media.generate')}
                  </ActionControl>
                  <p id={`${id}-unavailable`} className={css.reason}>{t('media.generationUnavailable')}</p>
                </div>
              </Panel>
              <Panel className={css.preview}>
                <SectionHeader className={css.previewHeader}>
                  <h3>{t('media.preview')}</h3>
                  <span>
                    {ratio}<span className={css.dot}>·</span>{video ? videoResolution : '1k'}
                    {video && <><span className={css.dot}>·</span>{duration} s</>}
                    <span className={css.dot}>·</span>{model.name}
                  </span>
                </SectionHeader>
                <div className={css.previewCanvas}>
                  <div className={css.emptyFrame} data-media-ratio={ratio}
                    style={{ aspectRatio: `${String(width)} / ${String(height)}`, width: `min(100%, ${String(280 * width / height)}px)` }}>
                    <span className={css.emptyIcon}><MediaIcon kind={mode} /></span>
                  </div>
                  <span className={css.emptyCaption}>{t('media.noPreview')}</span>
                </div>
              </Panel>
            </div>
            <Panel className={css.gallery}>
              <SectionHeader className={css.galleryHeader}>
                <span className={css.purple}><MediaIcon kind="gallery" /></span>
                <h3>{t('media.gallery')}</h3>
                <span className={css.count}>0</span>
              </SectionHeader>
              <div className={css.galleryGrid} data-media-gallery="" aria-label={t('media.gallery')}>
                <div className={css.galleryEmpty}>
                  <span className={css.galleryGlyph}><MediaIcon kind="image" /></span>{t('media.noGenerations')}
                </div>
              </div>
            </Panel>
          </>}
        </div>
      </div>
    </AppSurface>
  )
}
