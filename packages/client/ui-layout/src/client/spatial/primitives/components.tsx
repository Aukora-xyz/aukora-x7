// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE SPATIAL PRIMITIVES: every portal, record, field block, stat, pill and owner action in the
 * face is one of these, and they only emit the markup `primitives.css` styles. Measurements live in that file.
 *
 *   AppSurface + AppHeader       an app's lane surface, its eyebrow, title and badges
 *   PortalGrid / PortalCell      the home grid (two columns at two-thirds, one at one-third)
 *   PortalButton                 icon tile, title, one-line summary, optional badge, + / − expander; opens in place
 *   PortalLauncher               the same head, opening an application in the centre lane (menus and centre alike)
 *   PortalDetail / DetailSection the opened state's body and its small-caps sections
 *   RecordRow / RecordList       the nested, smaller portal (status pill + expander), or a static row
 *   FieldTable                   the fine-lined key/value block
 *   StatTiles, StatusPill, Meter, LevelScale, Quote, Lead
 *   LockedAction                 the lock pill that opens the owner origin; never an action in place
 *   ActionControl                a native button (or link) that does one ordinary thing in place, behind the app's own checks
 *   Panel / SectionHeader        a plain dark-glass surface, and a row heading inside it, for an app's own composition
 */
import { Fragment, useId, useState } from 'react'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { AkIcon, type IconName } from './icons.tsx'

/** The four-level palette, plus red (quarantine, failure) and muted (nothing to say). */
export type Tone = 'mint' | 'blue' | 'violet' | 'gold' | 'red' | 'muted'

const cx = (...values: (string | false | null | undefined)[]) => values.filter(Boolean).join(' ')
const tone = (value: Tone | undefined) => (value === undefined ? undefined : `ak-tone-${value}`)
/** Whether a slot holds anything to draw (an empty slot is not rendered, so it holds no space). */
const hasText = (value: ReactNode) => value !== undefined && value !== null && value !== '' && value !== false

/** What a tile shows: one of the primitives' glyphs by name, or a drawn element (never a bare string that is not a glyph). */
export type TileIcon = IconName | Exclude<ReactNode, string>

/** The 30px tile every portal carries. */
export function IconTile({ icon, tone: t }: { readonly icon: TileIcon; readonly tone?: Tone | undefined }) {
  return <span className={cx('ak-icon-tile', tone(t))}>{typeof icon === 'string' ? <AkIcon name={icon as IconName} /> : icon}</span>
}

// ── App surface and header ─────────────────────────────────────────────────────────────────────────────────────

export function AppSurface({ active, tone: t, children, ...data }: {
  readonly active: boolean
  readonly tone?: Tone
  readonly children: ReactNode
} & Record<`data-${string}`, string | undefined>) {
  return <section {...data} className={cx('ak-app', tone(t))} hidden={!active}>{active ? <div className="ak-canvas">{children}</div> : null}</section>
}

export interface Badge { readonly text: string; readonly tone?: Tone; readonly icon?: IconName; readonly title?: string }

/**
 * The standard app header (Spatial design spec 5): the TITLE FIRST (white), then the smaller descriptive line
 * in the app's tone beneath it, sharing the title's left edge; the badges sit in a reserved trailing area that holds no
 * space when there are none, and the header keeps clear of the lane's hot corner. The DOM order is the visible order:
 * no stylesheet reorders it. `eyebrow` is that descriptive line (the prop keeps its old name for every caller).
 */
export function AppHeader({ eyebrow, title, tone: t, badges = [], actions }: {
  readonly eyebrow: string
  readonly title: string
  readonly tone?: Tone
  readonly badges?: readonly Badge[]
  /**
   * The header's own tools (an `ActionControl`, say), drawn in the same trailing area after the badges, in the header's
   * flow: they wrap below the title and its line before they would cover them. Nothing is drawn when absent.
   */
  readonly actions?: ReactNode
}) {
  const tools = hasText(actions)
  return (
    <header className={cx('ak-header', tone(t))}>
      <div className="ak-header__copy">
        <h2 className="ak-header__title">{title}</h2>
        <p className="ak-header__eyebrow">{eyebrow}</p>
      </div>
      {badges.length === 0 && !tools ? null : (
        <div className="ak-header__badges">
          {badges.map(badge => (
            <span key={badge.text} className={cx('ak-badge', tone(badge.tone))} title={badge.title}>
              {badge.icon === undefined ? null : <AkIcon name={badge.icon} />}{badge.text}
            </span>
          ))}
          {tools ? actions : null}
        </div>
      )}
    </header>
  )
}

export function Footnote({ children }: { readonly children: ReactNode }) {
  return <p className="ak-footnote"><AkIcon name="lock" />{children}</p>
}

// ── Portals ────────────────────────────────────────────────────────────────────────────────────────────────────

export function PortalGrid({ open, children }: { readonly open: boolean; readonly children: ReactNode }) {
  return <ul className="ak-grid" data-open={open ? 'yes' : 'no'}>{children}</ul>
}

export function PortalCell({ children, ...data }: { readonly children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return <li {...data}>{children}</li>
}

/** The layout primitives' old accent names, still accepted (Prime's memory app passes them). */
type LegacyAccent = 'blue' | 'green' | 'purple' | 'gold' | 'red-warning'
const LEGACY: Record<LegacyAccent, Tone> = { 'blue': 'blue', 'green': 'mint', 'purple': 'violet', 'gold': 'gold', 'red-warning': 'red' }

/**
 * WHAT A PORTAL HEAD MEANS (Spatial design spec 6). Each pattern has one meaning, and the markup says which:
 *   launcher     opens or reveals an application in the centre lane (`PortalLauncher`); `aria-current` while it is shown
 *   disclosure   expands its own body in place (`PortalButton` with children, `PortalFold`); `aria-expanded`
 *   record row   selects or inspects one item (`RecordRow`), a distinct, smaller component
 *   action       performs one thing, behind its authority check (`LockedAction`, which only opens the owner origin)
 * A visual "open" never authorises anything: no launcher or disclosure executes, signs, sends, provisions or approves.
 */
export type PortalKind = 'launcher' | 'disclosure'

/** The glyph a portal without its own gets, on purpose: an app tile for a launcher, the general mark for a disclosure. */
export const FALLBACK_ICON: Readonly<Record<PortalKind, IconName>> = { launcher: 'app', disclosure: 'general' }

const expander = (open: boolean) => <span className="ak-expander" aria-hidden="true">{open ? '−' : '+'}</span>

/**
 * The one head every portal draws (launcher, disclosure, fold): the 30px tile (always: a missing icon gets the fallback,
 * so no title shifts sideways), the title and its one-line summary, and the trailing area, which is not rendered at all
 * when it would be empty.
 */
function PortalHeadContent({ kind, icon, iconTone, title, summary, end }: {
  readonly kind: PortalKind
  readonly icon: TileIcon | undefined
  readonly iconTone: Tone | undefined
  readonly title: ReactNode
  readonly summary: ReactNode
  readonly end: readonly ReactNode[]
}) {
  const shown = end.filter(hasText)
  return (
    <>
      <IconTile icon={icon === undefined || icon === null ? FALLBACK_ICON[kind] : icon} tone={iconTone} />
      <span className="ak-portal__copy">
        <span className="ak-portal__title">{title}</span>
        {hasText(summary) ? <span className="ak-portal__summary">{summary}</span> : null}
      </span>
      {shown.length === 0 ? null : <span className="ak-portal__end">{shown.map((part, index) => <Fragment key={index}>{part}</Fragment>)}</span>}
    </>
  )
}

export interface PortalButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children' | 'onToggle'> {
  readonly tone?: Tone
  /** The glyph in the 30px tile. Every new portal passes one; without it the tile shows `FALLBACK_ICON`. */
  readonly icon?: TileIcon
  /** The tile's own colour when it differs from the border's (menu launchers: border = tab, icon = per app). */
  readonly iconTone?: Tone
  readonly title: ReactNode
  /** One line; ellipsis beyond it. The head is the standard height with or without it. */
  readonly summary?: ReactNode
  /** A status pill, count or meter shown before the expander. */
  readonly badge?: ReactNode
  /** Controlled open state; omit for a self-contained disclosure. */
  readonly expanded?: boolean
  readonly defaultExpanded?: boolean
  readonly onToggle?: (open: boolean) => void
  /** A launcher in a right-hand menu: `aria-current` while its app is open. New menus use `PortalLauncher`. */
  readonly menu?: boolean
  /** What opens below the header (rendered inside `PortalDetail`). A launcher has none. */
  readonly children?: ReactNode
  // The previous PortalButton's props (Prime's memory app uses them). A caller that passes any of these gets the same
  // frame, tile, expander AND the same head geometry: an old prop never switches a portal to another height.
  readonly variant?: LegacyAccent
  readonly subtitle?: ReactNode
  readonly trailing?: ReactNode
  readonly showIndicator?: boolean
  readonly onExpandedChange?: (open: boolean) => void
  readonly buttonClassName?: string | undefined
  readonly contentClassName?: string | undefined
  readonly containerProps?: HTMLAttributes<HTMLDivElement> & { [name: `data-${string}`]: string | number | boolean | undefined }
  readonly contentProps?: HTMLAttributes<HTMLDivElement>
}

/**
 * The portal button: a DISCLOSURE when it has children (it opens in place, inside the lane it is in; it never resizes
 * a lane and never navigates). Without children it is drawn as a launcher; new launchers use `PortalLauncher`.
 */
export function PortalButton({
  tone: t, icon, iconTone, title, summary, badge, expanded, defaultExpanded = false, onToggle, menu = false, children, className, onClick,
  variant, subtitle, trailing, showIndicator = true, onExpandedChange, buttonClassName, contentClassName, containerProps, contentProps,
  ...button
}: PortalButtonProps) {
  const [local, setLocal] = useState(defaultExpanded)
  const open = expanded ?? local
  const bodyId = useId()
  const opens = children !== undefined
  const kind: PortalKind = opens ? 'disclosure' : 'launcher'
  return (
    <div
      {...containerProps}
      className={cx('ak-portal', tone(t ?? (variant === undefined ? 'blue' : LEGACY[variant])), menu && 'ak-portal--menu', className,
        containerProps?.className)}
      data-open={open ? 'yes' : 'no'}
      data-portal-kind={kind}
    >
      <button
        {...button}
        type="button"
        className={cx('ak-portal__head', buttonClassName)}
        aria-expanded={opens ? open : undefined}
        aria-controls={opens ? bodyId : undefined}
        aria-current={menu && open ? 'page' : undefined}
        onClick={(event) => {
          onClick?.(event)
          if (event.defaultPrevented) return
          if (expanded === undefined) setLocal(!open)
          onToggle?.(!open)
          onExpandedChange?.(!open)
        }}
      >
        <PortalHeadContent kind={kind} icon={icon} iconTone={iconTone} title={title} summary={summary ?? subtitle}
          end={[badge, trailing, showIndicator ? expander(open) : null]} />
      </button>
      {opens && open ? <PortalDetail id={bodyId} className={contentClassName} props={contentProps}>{children}</PortalDetail> : null}
    </div>
  )
}

export interface PortalLauncherProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children' | 'onClick'> {
  readonly tone?: Tone
  readonly icon?: TileIcon
  readonly iconTone?: Tone
  readonly title: ReactNode
  readonly summary?: ReactNode
  readonly badge?: ReactNode
  /** Its application is the one shown in the centre lane. */
  readonly current: boolean
  /** Open or reveal the application. Navigation only: it grants nothing. */
  readonly onOpen: () => void
  /**
   * Selecting the launcher of the application already shown: with `onClose` it closes it (the desktop menus' − ); without
   * it, selecting reveals the application again and never toggles the centre lane to empty.
   */
  readonly onClose?: () => void
  /** Sits in a right-hand menu stack. */
  readonly menu?: boolean
}

/**
 * THE APPLICATION LAUNCHER: the same frame, tile, title, summary and head geometry as every portal, in the centre lane
 * and in the menus alike. It has no body and no `aria-expanded` (it opens an application, not content in place); it
 * carries `aria-current="page"` while its application is shown.
 */
export function PortalLauncher({
  tone: t, icon, iconTone, title, summary, badge, current, onOpen, onClose, menu = false, className, ...button
}: PortalLauncherProps) {
  return (
    <div className={cx('ak-portal', tone(t ?? 'blue'), menu && 'ak-portal--menu', className)} data-open={current ? 'yes' : 'no'}
      data-portal-kind="launcher">
      <button
        {...button}
        type="button"
        className="ak-portal__head"
        aria-current={current ? 'page' : undefined}
        onClick={() => { if (current && onClose !== undefined) onClose(); else onOpen() }}
      >
        <PortalHeadContent kind="launcher" icon={icon} iconTone={iconTone} title={title} summary={summary}
          end={[badge, expander(current)]} />
      </button>
    </div>
  )
}

/**
 * A Portal card drawn exactly like PortalButton, for a card whose closed body must stay in the page: a native
 * `<details>` (its summary is the card head), a disclosure. Without children it is a static card, head only, with no
 * expander, whose words wrap instead of being cut.
 * Use it where a closed card still holds something the page keeps (a refusal, a code, a scope); PortalButton otherwise.
 */
export function PortalFold({ tone: t, icon, title, summary, badge, children, defaultOpen = false, ...data }: {
  readonly tone?: Tone | undefined
  readonly icon?: IconName | undefined
  readonly title: ReactNode
  readonly summary?: ReactNode
  readonly badge?: ReactNode
  readonly children?: ReactNode
  readonly defaultOpen?: boolean
} & Record<`data-${string}`, string | undefined>) {
  const [open, setOpen] = useState(defaultOpen)
  const opens = children !== undefined && children !== null && children !== false
  const head = <PortalHeadContent kind="disclosure" icon={icon} iconTone={undefined} title={title} summary={summary}
    end={[badge, opens ? expander(open) : null]} />
  // A head-only card cannot open, so its words wrap and grow the head (the free form): nothing it says is cut by an ellipsis.
  const frame = cx('ak-portal', tone(t ?? 'blue'), opens ? 'ak-portal--fold' : 'ak-portal--static ak-portal--free')
  if (!opens) return <div {...data} className={frame} data-open="no"><div className="ak-portal__head">{head}</div></div>
  return (
    <details {...data} className={frame} data-open={open ? 'yes' : 'no'} data-portal-kind="disclosure" open={defaultOpen || undefined}
      onToggle={(event) => { setOpen(event.currentTarget.open) }}>
      <summary className="ak-portal__head">{head}</summary>
      <PortalDetail>{children}</PortalDetail>
    </details>
  )
}

/** The opened state's body: 16px inset, 4px rhythm, glides in. */
export function PortalDetail({ id, className, props, children }: {
  readonly id?: string
  readonly className?: string | undefined
  readonly props?: HTMLAttributes<HTMLDivElement> | undefined
  readonly children: ReactNode
}) {
  return <div {...props} className={cx('ak-portal__body', className)} id={id}>{children}</div>
}

/** A small-caps section label and what sits under it. */
export function DetailSection({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <section><p className="ak-label">{label}</p>{children}</section>
}

export function SectionLabel({ children }: { readonly children: ReactNode }) {
  return <p className="ak-label">{children}</p>
}

// ── Record rows ────────────────────────────────────────────────────────────────────────────────────────────────

export function RecordList({ children }: { readonly children: ReactNode }) {
  return <ul className="ak-rows">{children}</ul>
}

/**
 * The nested, smaller portal: title, one-line summary, a status pill (and anything else short) and the expander.
 * Without children it is a static row: a hairline frame, no expander, nothing to open.
 */
export function RecordRow({ tone: t, title, summary, status, end, children, rowTitle }: {
  readonly tone: Tone
  readonly title: ReactNode
  readonly summary?: ReactNode
  readonly status?: ReactNode
  readonly end?: ReactNode
  readonly children?: ReactNode
  /** Full text for the tooltip when the one-line summary is cut. */
  readonly rowTitle?: string
}) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const copy = (
    <span className="ak-row__copy">
      <span className="ak-row__title">{title}</span>
      {summary === undefined ? null : <span className="ak-row__summary">{summary}</span>}
    </span>
  )
  const trailing = <span className="ak-row__end">{end}{status}{children === undefined ? null : <span className="ak-expander" aria-hidden="true">{open ? '−' : '+'}</span>}</span>
  if (children === undefined) {
    return <li className={cx('ak-row', 'ak-row--static', tone(t))} title={rowTitle}><div className="ak-row__head">{copy}{trailing}</div></li>
  }
  return (
    <li className={cx('ak-row', tone(t))} data-open={open ? 'yes' : 'no'}>
      <button type="button" className="ak-row__head" aria-expanded={open} aria-controls={bodyId} title={rowTitle} onClick={() => { setOpen(!open) }}>
        {copy}{trailing}
      </button>
      {open ? <div className="ak-row__body" id={bodyId}>{children}</div> : null}
    </li>
  )
}

// ── Fields, stats, pills, meters ───────────────────────────────────────────────────────────────────────────────

/** Names left, exact values right in monospace, never truncated. */
export function FieldTable({ title, rows }: { readonly title?: string; readonly rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <>
      {title === undefined ? null : <p className="ak-fields__title">{title}</p>}
      <dl className="ak-fields">
        {rows.map(([name, value]) => [<dt key={`${name}-k`}>{name}</dt>, <dd key={`${name}-v`}>{value}</dd>])}
      </dl>
    </>
  )
}

export interface StatTile { readonly name: string; readonly value: ReactNode; readonly tone?: Tone }

export function StatTiles({ tiles }: { readonly tiles: readonly StatTile[] }) {
  return (
    <div className="ak-stats">
      {tiles.map(tile => (
        <div key={tile.name} className={cx('ak-stat', tone(tile.tone))}>
          <span className="ak-stat__name">{tile.name}</span>
          <b className="ak-stat__value">{tile.value}</b>
        </div>
      ))}
    </div>
  )
}

export function StatusPill({ tone: t, children, title }: { readonly tone: Tone; readonly children: ReactNode; readonly title?: string }) {
  return <span className={cx('ak-pill', tone(t))} title={title}>{children}</span>
}

export function Meter({ used, cap, tone: t }: { readonly used: number; readonly cap: number; readonly tone: Tone }) {
  const share = cap <= 0 ? 0 : Math.min(1, Math.max(0, used / cap))
  return (
    <span className={cx('ak-meter', tone(t))} role="img" aria-label={`${String(used)} of ${String(cap)}`}>
      <i style={{ width: `${String(Math.round(share * 100))}%` }} />
    </span>
  )
}

export interface Level { readonly key: string; readonly name: string; readonly label: string; readonly tone: Tone }

/** A read-only row of levels with the current one lit (the Laya slider, shown, not moved). */
export function LevelScale(
  { levels, current, label }: { readonly levels: readonly Level[]; readonly current: string; readonly label: string },
) {
  return (
    <div className="ak-scale" role="img" aria-label={label}>
      {levels.map(level => (
        <div key={level.key} className={cx('ak-scale__notch', tone(level.tone))} aria-current={level.key === current ? 'true' : 'false'}>
          <span className="ak-scale__dot" />
          <b>{level.name}</b>
          <span>{level.label}</span>
        </div>
      ))}
    </div>
  )
}

export function Quote({ children, tone: t }: { readonly children: ReactNode; readonly tone?: Tone }) {
  return <p className={cx('ak-quote', tone(t))}>{children}</p>
}

export function Lead({ children }: { readonly children: ReactNode }) {
  return <p className="ak-lead">{children}</p>
}

export function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="ak-mono">{children}</span>
}

// ── The locked action ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE ONLY CONTROL THAT CHANGES ANYTHING, AND IT CHANGES NOTHING HERE. A link to the owner origin, where the owner's
 * passkey screen shows its own card. A surface in the engine's origin never approves, revokes or writes in place.
 */
export function LockedAction({ verb, href, tone: t, note, title }: {
  readonly verb: string
  readonly href: string
  readonly tone: Tone
  readonly note: string
  readonly title?: string
}) {
  return (
    <div className="ak-actionrow">
      <a className={cx('ak-action', tone(t))} href={href} target="_blank" rel="noopener noreferrer" title={title ?? href}>
        <AkIcon name="lock" />{verb}<AkIcon name="out" />
      </a>
      <span className="ak-action__note">{note}</span>
    </div>
  )
}

// ── Ordinary actions and an app's own composition ──────────────────────────────────────────────────────────────

interface ActionControlStyle {
  /** The control's colour; blue when not given (never inherited from the surface around it). */
  readonly tone?: Tone
}

/** A button: `controlRef` reaches the element (a tab list moves focus with it). */
export type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & ActionControlStyle & {
  readonly href?: undefined
  readonly controlRef?: Ref<HTMLButtonElement>
}

/** A link drawn as the same control. */
export type ActionLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & ActionControlStyle & {
  readonly href: string
  readonly controlRef?: Ref<HTMLAnchorElement>
}

export type ActionControlProps = ActionButtonProps | ActionLinkProps

/**
 * AN ORDINARY ACTION IN PLACE: a native `<button>` (or, with `href`, a link) in the tone's outline. It does what its app
 * does on a click, behind that app's own checks; it is not an approval, a signature or a grant (an owner approval is
 * `LockedAction`, or the passkey card). `aria-pressed` and `aria-current` light it; `aria-pressed="false"` mutes it.
 * Its look is a floor of zero specificity (`:where(.ak-control)` in `primitives.css`): the app's own class refines it.
 * It carries `data-aukora-action`, so the stock-launcher skin never draws it as a menu launcher.
 */
export function ActionControl(props: ActionControlProps) {
  if (props.href !== undefined) {
    const { tone: t = 'blue', className, controlRef, ...link } = props
    return <a {...link} ref={controlRef} className={cx('ak-control', tone(t), className)} data-aukora-action="" />
  }
  const { tone: t = 'blue', className, controlRef, type = 'button', ...button } = props
  return <button {...button} ref={controlRef} type={type} className={cx('ak-control', tone(t), className)} data-aukora-action="" />
}

/**
 * A PLAIN DARK-GLASS SURFACE (hairline, the portal radius, the portal surface) that an app composes its own content in:
 * not a portal (it has no head and opens nothing). A floor of zero specificity: the app's class sets its geometry.
 */
export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx('ak-panel', className)} />
}

/** A heading row inside a panel: one line of the caller's own heading, glyphs and controls, in its own order. */
export function SectionHeader({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <header {...props} className={cx('ak-section-header', className)} />
}
