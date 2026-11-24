/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, IconEllipsisOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps, ConversationViewActionsOwnerProps,
} from '../contract/slots.ts'
import { resolveActiveView } from '../view-selection.ts'
import { FIXED_VIEW_ID } from '../view-pins.ts'
import { DefaultConversationViews } from './DefaultConversationViews.tsx'
import { spatialChrome, type SpatialChrome } from './spatial-chrome.ts'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

type ViewsMoreMenuProps =
  Omit<ConversationViewActionsOwnerProps, 'onDismiss'>
  & Pick<ConversationSessionHeaderSlotProps, 'renderSlot'>
  & { readonly label: string; readonly current: boolean }

/** The View tab row's More launcher; its menu rows come from `conversation.session.header.views.actions`. */
function ViewsMoreMenu({ label, current, entries, onOpen, onPinnedChange, renderSlot }: ViewsMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <Menu open={open} onClose={onDismiss} portal autoFocus className={css.viewsMoreAnchor} listClassName={css.viewsMoreMenu}
      anchor={(
        <Tooltip label={label} portal>
          <Button size="sm" className={clsx(css.viewsMore, current && css.viewsMoreActive)} aria-label={label} aria-haspopup="menu" aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}>
            <IconEllipsisOutlineRegular size={13} />
          </Button>
        </Tooltip>
      )}>
      {renderSlot('conversation.session.header.views.actions', { entries, onOpen, onPinnedChange, onDismiss })}
    </Menu>
  )
}

/** Approximate 13px text advance: full-width glyphs take one em, other glyphs about half. */
const WIDE_GLYPH = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u
const WIDE_GLYPH_WIDTH = 13
const NARROW_GLYPH_WIDTH = 7
/** Mirrors the `.tabLabel` max-width in `ConversationRoot.module.css`. */
const TAB_LABEL_MAX_WIDTH = 88

/** Estimate whether a View tab label exceeds its 88px cell. */
function labelNeedsTooltip(label: string): boolean {
  let width = 0
  for (const glyph of label) width += WIDE_GLYPH.test(glyph) ? WIDE_GLYPH_WIDTH : NARROW_GLYPH_WIDTH
  return width > TAB_LABEL_MAX_WIDTH
}

/** One View tab label; its full-name tooltip is offered only when the text is expected to overflow. */
function ViewTabLabel({ label }: { readonly label: string }) {
  return (
    <Tooltip label={label} portal disabled={!labelNeedsTooltip(label)}>
      <span className={css.tabLabel}>{label}</span>
    </Tooltip>
  )
}

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
  readonly subagent: boolean
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({
      id: summary.id,
      displayTitle: summary.displayTitle,
      subagent: summary.origin === 'subagent',
    })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

/**
 * THE OPEN THREAD'S TITLE IN THE SPATIAL SHELL, renamed in place (Round 23). The name is plain text, so it stays part of
 * the header's drag row; the pencil beside it turns it into a field holding the whole name, selected.
 *   Enter       saves any non-empty name through the host's rename, an unchanged one too: like the classic shell, that
 *               pins the automatic title so it stops changing.
 *   Escape      keeps the old name.
 *   leaving it  saves only a name that differs from the one it opened with, and never when the window itself lost the
 *               focus (switching apps keeps the field open).
 * What shows afterwards is the store's title (the host may trim it); a refusal is said on its own line under the header.
 * @param props - the session, its current title, the host rename, and where to say a refusal.
 * @returns the title and its pencil, or the field.
 */
function ThreadTitle({ sessionId, displayTitle, rename, onRefusal }: {
  readonly sessionId: SessionId
  readonly displayTitle: string
  readonly rename: SpatialChrome['renameThread']
  readonly onRefusal: (reason: string | null) => void
}) {
  const [edit, setEdit] = useState<{ readonly draft: string; readonly original: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // The name is selected once, when the field opens; focus coming back after a window switch keeps the draft as it is.
  const selected = useRef(false)
  const close = (): void => { setEdit(null); onRefusal(null) }
  const save = (explicit: boolean): void => {
    if (edit === null || busy) return
    const title = edit.draft.trim()
    if (title === '' || (!explicit && title === edit.original.trim())) { close(); return }
    setBusy(true)
    rename(sessionId, title).then(
      () => { setBusy(false); close() },
      (cause: unknown) => { setBusy(false); onRefusal(cause instanceof Error ? cause.message : String(cause)) },
    )
  }
  if (edit !== null) {
    return (
      <span className={css.titleEdit} data-thread-title-edit="">
        <input
          className={css.titleInput}
          aria-label="Thread name"
          value={edit.draft}
          maxLength={200}
          disabled={busy}
          // The field appears because the person asked for it with the pencil, so it takes the focus.
          autoFocus
          // The whole name is selected, so typing replaces it and an arrow key keeps it.
          onFocus={(event) => { if (!selected.current) { selected.current = true; event.currentTarget.select() } }}
          onChange={(event) => { const draft = event.target.value; setEdit(current => (current === null ? null : { ...current, draft })) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); save(true) }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
          }}
          onBlur={() => { if (typeof document === 'undefined' || document.hasFocus()) save(false) }}
        />
      </span>
    )
  }
  return (
    <>
      <span className={clsx(css.crumb, css.crumbCurrent)} data-thread-title="" title={displayTitle}>{displayTitle}</span>
      <button
        type="button"
        className={css.titleRename}
        data-thread-rename=""
        aria-label="Rename thread"
        title="Rename thread"
        onClick={() => { selected.current = false; setEdit({ draft: displayTitle, original: displayTitle }); onRefusal(null) }}
      >
        {/* The same pencil as the Threads lane's cards, drawn inline so the two always match. */}
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M10.6 2.9l2.5 2.5-7.4 7.4-3.1.6.6-3.1 7.4-7.4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M9.3 4.2l2.5 2.5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
    </>
  )
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

/**
 * Renders Session header chrome above the resident conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns Session navigation controls, with title and tabs after conversation starts.
 */
export function ConversationSessionHeader({
  sessionId, hideChrome, useSessions, useConversationViews, useStore,
  renderSlot, open, useContextMenu, selectView, setPinned, t, useEntryPins, useEntryActions,
}: ConversationSessionHeaderProps) {
  const { getTriggerProps } = useContextMenu()
  const tabs = useConversationViews(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const unpinned = useEntryPins(ids => ids)
  const hasEntryActions = useEntryActions(registered => registered)
  // THE SPATIAL SHELL'S ONE LINE (Round 23): with its chrome published, the header is the title (renamed in place), the
  // lineage and the actions (mode, subagents), and nothing else: no view tabs, no utilities, no corner, no session menu.
  const chrome = spatialChrome()
  const compact = chrome !== null
  // A refused rename, said on its own line under the header (the title row clips anything beside the field).
  const [renameRefusal, setRenameRefusal] = useState<string | null>(null)
  const showTabs = !compact && !hideChrome && tabs.length > 1
  const tabRow = useRef<HTMLDivElement>(null)
  const [visibleViewLimit, setVisibleViewLimit] = useState(1)
  // Observe only the available row width; individual tabs are not measured.
  useLayoutEffect(() => {
    const row = tabRow.current
    if (row === null || !hasEntryActions) return
    const updateLimit = (): void => {
      setVisibleViewLimit(Math.max(1, Math.floor((row.clientWidth - 48) / 120)))
    }
    updateLimit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateLimit)
    observer.observe(row)
    return () => { observer.disconnect() }
  }, [showTabs, hasEntryActions])
  const { visibleTabs, moreTabs } = useMemo(() => {
    const preferred = [
      ...tabs.filter(tab => tab.id === FIXED_VIEW_ID),
      ...tabs.filter(tab => tab.id !== FIXED_VIEW_ID && !unpinned.includes(tab.id)),
    ]
    const visibleTabs = hasEntryActions ? preferred.slice(0, visibleViewLimit) : preferred
    const visibleIds = new Set(visibleTabs.map(tab => tab.id))
    return { visibleTabs, moreTabs: tabs.filter(tab => !visibleIds.has(tab.id)) }
  }, [tabs, unpinned, hasEntryActions, visibleViewLimit])
  const currentInMore = moreTabs.some(tab => tab.id === active?.id)
  // THE SPATIAL LINE'S CENTRE (after Round 32): the name keeps the left with its pencil; the thread's mode and its
  // subagent count sit together at the top centre. A subagent's own lineage stays on its crumb.
  const current = ancestry.length === 0 ? undefined : ancestry[ancestry.length - 1]
  const centerOwner = compact && current !== undefined && !current.subagent
    ? { lineageSessionId: current.id, displayTitle: current.displayTitle } : null
  return (
    <>
      <div className={css.titleRow} data-conversation-chrome={compact ? 'compact' : undefined}>
        {!hideChrome && (
          <>
            <div className={css.titleCluster}>
              <nav className={css.crumbs} aria-label={t('session.hierarchy')}>
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1
                  // The current crumb has no navigation, so it is plain text
                  // rather than a disabled button: on darwin desktop a button
                  // would subtract itself from the header's drag row (ui-web
                  // base.css) and leave the title inert for dragging too.
                  const title = last
                    ? compact && !summary.subagent
                      ? (
                        <ThreadTitle sessionId={summary.id} displayTitle={summary.displayTitle} rename={chrome.renameThread}
                          onRefusal={setRenameRefusal} />
                      )
                      : (
                        <span className={clsx(css.crumb, summary.subagent && css.crumbSubagent, css.crumbCurrent)}>
                          {summary.displayTitle}
                        </span>
                      )
                    : (
                      <button
                        type="button"
                        className={clsx(css.crumb, summary.subagent && css.crumbSubagent)}
                        onClick={() => { open(summary.id) }}
                      >
                        {summary.displayTitle}
                      </button>
                    )
                  const lineage = last || summary.subagent
                  const lineageOwner = {
                    lineageSessionId: summary.id,
                    displayTitle: summary.displayTitle,
                    ...last ? {} : { openTitle: () => { open(summary.id) } },
                  }
                  return (
                    <span
                      key={summary.id}
                      className={css.crumbSeg}
                      // The Spatial line has no session menu: its stock Rename is a dialog, and this line renames in place.
                      {...compact ? {} : getTriggerProps({ kind: 'session', value: { sessionId: summary.id, displayTitle: summary.displayTitle } })}
                    >
                      {index > 0 && <span className={css.crumbSep}>/</span>}
                      {lineage
                        ? summary.subagent
                          ? renderSlot(
                            'conversation.session.header.lineage',
                            lineageOwner,
                            { fallback: title },
                          )
                          : (
                            <>
                              {title}
                              {compact ? null : renderSlot(
                                'conversation.session.header.lineage',
                                lineageOwner,
                                { fallback: null },
                              )}
                            </>
                          )
                        : title}
                    </span>
                  )
                })}
                {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
              </nav>
              {compact ? (
                <div className={clsx(css.headerActions, css.headerCenter)} data-conversation-center="">
                  {centerOwner === null ? null : renderSlot('conversation.session.header.lineage', centerOwner, { fallback: null })}
                  {renderSlot('conversation.session.header.actions', {})}
                </div>
              ) : (
                <div className={css.headerActions}>
                  {renderSlot('conversation.session.header.actions', {})}
                </div>
              )}
            </div>
            {compact ? null : (
              <div className={css.headerUtilities}>
                {renderSlot('conversation.session.header.utilities', {})}
              </div>
            )}
          </>
        )}
        {compact ? null : (
          <div className={css.headerCorner} data-conversation-header-corner="">
            {renderSlot('conversation.session.header.corner', {})}
          </div>
        )}
      </div>
      {compact && renameRefusal !== null ? (
        <p className={css.titleRefusal} role="status" data-thread-title-error="">{`Not renamed: ${renameRefusal}`}</p>
      ) : null}
      {showTabs && (
        // data-conversation-tabs: marks the tab strip, which the window-chrome
        // geometry and the browser coverage lane anchor on.
        <div ref={tabRow} className={css.tabs}>
          <div className={css.viewTabs} role="tablist" data-conversation-tabs="">
            {visibleTabs.map(viewTab => (
              <button
                key={viewTab.id}
                type="button"
                role="tab"
                aria-selected={viewTab.id === active?.id}
                className={clsx(css.tab, viewTab.id === active?.id && css.tabActive)}
                onClick={() => { selectView(viewTab.id) }}
              >
                <ViewTabLabel label={viewTab.label} />
              </button>
            ))}
          </div>
          {hasEntryActions && (
            <ViewsMoreMenu
              label={t('session.moreViews')}
              current={currentInMore}
              entries={moreTabs.map(viewTab => ({
                id: viewTab.id, label: viewTab.label,
                pinned: !unpinned.includes(viewTab.id), active: viewTab.id === active?.id,
              }))}
              onOpen={selectView}
              onPinnedChange={setPinned}
              renderSlot={renderSlot}
            />
          )}
        </div>
      )}
    </>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession(props: ConversationSessionProps) {
  return <DefaultConversationViews {...props} />
}
