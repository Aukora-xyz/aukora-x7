# Spatial app design rules (read before any UI task)

These are the rules every Spatial surface follows. The primitives below live in
`packages/client/ui-layout/src/client/spatial/primitives/` (`primitives.css` for the framework-neutral `ak-` classes and
tokens, `components.tsx` for React). The component catalogue is `docs/foundations/SPATIAL-CATALOGUE.md`.

1. One surface. Every lane, panel and face uses the SAME background as the right menu lane. Never darker, never lighter,
   never a separate flat panel.
2. One button. Every button, card and tab: the same surface background with a thin coloured border. Colours: mint
   (green), blue, violet (purple), gold; red only for danger/critical. Selected/highlighted states are the same for
   every control (the same border weight and glow); no one-off styles.
3. Three equal lanes, ten presets, five hot corners; no top bar. Hot corners and menu tab icons have NO visible border
   (hover glow only). Every corner tap moves exactly ONE third, never a snap to 1·1·1: a full centre plus the top-left
   corner brings in only the threads (1·2·0), so the app stays open beside the chat; a full lane gives one third back.
   Picking an app in the right menu changes only the centre lane; the owner pushes the menu out with its corner. Every
   preset change glides.
4. Stock apps (Lingwa, Live, Zeta Harp, Human Graph, Media, Memory, Messages, Documents) are kept as they were built,
   never rewritten. Complete original apps are vendored byte for byte in frames, pinned by hash. React surfaces copy
   the .module.css verbatim and match the DOM, icons and text exactly. A "write fresh" rule does not apply to stock apps.
4b. Memory is never signed and has no proposals: notes are simply kept. Memory shows Remembered (search) and Forgotten.
4c. No back arrows: a portal's own header opens and closes it. Threads-lane icons are plain white, no box, colour only
   when pressed/active.
5. Design primitives live in one place (tokens, surface, button, card, tab); faces use them, never their own colours.
6. Any change to the look is previewed by the node's owner (localhost or a node) before it lands. Icons and colour,
   minimal text.
7. Two kinds of button, one look. A NAVIGATION button takes you somewhere; these are essentially the right menu's cards.
   A PORTAL button opens a layer deeper in place: it telescopes open (to the whole lane, or nested inside its category)
   and closes again; the lane's top-left corner takes you back out (e.g. a thread portal fills the Threads lane, the
   corner returns to the list). Buttons in the centre of an app are portals. A portal button shows on its face that
   there is something below it (one consistent affordance). Lists are categories with portals under them that expand
   and contract, and portals may nest. This is three-dimensional navigation: lanes left and right (phone, tablet,
   desktop), portals one layer deeper; it must translate to AR. One format everywhere.
8. Once a primitive is settled, it changes only after the owner has previewed the change.
9. The owner ceremony (claim to approval) is the opening of the product: the same surface, no title-bar text, the AUMLOK
   heading style, no focus boxes on headings, a soft glide in. It must be beautiful.
10. THE PRIMITIVES. Every portal button, record, field block, stat, pill and owner action looks exactly like these.
   Source of truth (copy verbatim into any other bundle, e.g. the owner origin): `primitives.css` (framework-neutral
   `ak-` classes + tokens); React: `components.tsx` beside it. Measurements:
   - Palette: mint rgb(129,212,180), blue rgb(150,180,255), violet rgb(196,170,255), gold rgb(224,183,106); red
     rgb(242,85,90) ONLY for quarantine/failure/danger; muted rgb(139,144,153); text rgb(232,234,237); secondary
     rgb(184,188,196); hairline rgba(255,255,255,.10); surface rgba(38,43,54,.72).
   - Tone ring (the "repetition of the colour"): 1px border in the tone at 30% at rest; 70% + glow 0 0 14px tone at
     14% when open or hovered. Never thicker than 1px.
   - PortalButton: radius 14px; header at least 68px for EVERY head, title-only included (the 52px title-only height
     is retired): a floor, not a fixed height, so larger text grows the head instead of clipping it, and no prop picks
     another height; padding 4px 16px; gap 12px; a missing icon gets the fallback tile;
     icon tile 30x30px, radius 10px, inset 1px ring tone 28%, glyph 16px stroke 1.4 round, tone colour;
     title .84375rem (13.5px) line 1.48 weight 520 tracking .02em; summary .71875rem (11.5px) muted; both one line with
     ellipsis; optional badge (status pill / count) then the expander "+" closed / "−" open, 18px, tone. Opens IN PLACE
     within the lane it is in (never resizes a lane); the other portals step aside; its own header closes it.
   - Right-hand menu launchers are `PortalLauncher`s (the same head; `aria-current`, never `aria-expanded`):
     left-justified, the same 68px floor (title-only too) so stacks line up, 14px apart (the portal gap); tab colour:
     triangle (apps) mint, square (system) blue, circle (yours) violet.
   - PortalDetail (opened body): padding 4px 16px 18px, 4px rhythm; section labels mono 9.5px/14px weight 600
     tracking .16em caps muted, 14px above, 6px below.
   - RecordRow (nested portal): radius 12px, header 52px, padding 0 14px, gap 10px; title 12.5px/20px 500; summary
     11px/16px muted; status pill + expander on the right; body padding 0 14px 14px gap 10px; rows 6px apart. A
     static row (nothing below) has a neutral hairline and no expander. Nesting inset: 16px + 14px.
   - FieldTable ("the little fine lines"): 1px hairline, radius 10px, padding 10px 12px; key column max-content
     (min 84px), gap 4px 14px; key 11px/18px muted; value mono 11px/18px, never truncated.
   - StatTiles: auto-fit min 150px, gap 8px; tile hairline, radius 12px, padding 10px 12px; name 10.5px muted; value
     16px weight 480 in the tile's tone.
   - StatusPill: 1px tone 45%, radius 999px, padding 1px 8px, mono 9.5px/16px 600 tracking .10em caps, tone colour.
   - LockedAction: pill, 1px tone 38% (70% + glow on hover), radius 999px, min-height 28px, padding 3px 12px, 12px
     text, lock + outward-arrow glyphs 12px, a muted 11px note beside it. In the engine's origin a change is ALWAYS a
     link to the owner origin, never an action in place.
   - AppHeader: TITLE FIRST (DOM order = visible order, no CSS reordering): 1.5rem weight 480 tracking .08em caps,
     white; then the descriptive line (the `eyebrow` prop) mono 10px/14px 600 tracking .16em caps in the app's tone
     (keep it, on every app), on the title's left edge; badges right (READ-ONLY, PREVIEW DATA), then the header's own
     tools (the `actions` prop), in a trailing area that is not drawn when empty and is IN THE HEADER'S FLOW: beside
     the line when it fits, else on a row of its own (always its own row in a phone's lane). Nothing in a header is
     positioned over another part. Hot-corner clearance kept; 18px below, hairline under. Every header band (centre
     66px, lane 84px) is a min-height floor that grows with larger text; lane header tools wrap under the heading.
     ONE EXCEPTION, still open: the open conversation's lane header (`.x5-conversation-header`, spatial-layer.css) is a
     fixed 84px, because the conversation frame below it (`.x5-genesis-frame`) is inset by exactly 84px; at 200% text
     it can spill past its hairline until that inset follows the band's height.
     The left (Threads) and right (menu) lane headings use the same 1.5rem. App canvas max 760px, centred, 14px
     between blocks.
   - ActionControl (an ordinary action in place, a button or a link), Panel and SectionHeader are the newer family's
     floors for an app's own composition (zero specificity: the app's class refines them). The legacy
     `spatial/primitives.tsx` has no consumer left.
   - Grid: auto-fill min 280px, gap 14px (two columns at two-thirds of a 1440 window, one at one-third).
   - Motion: open glides in (opacity, 6px rise, 220ms); borders ease 180ms; none under reduced motion.
   - Thread rows (left lane) are PortalButtons too: 68px, the thread mark inside a mint 30px tile, + / − (− on the
     open thread). This SUPERSEDES 4c's "plain white, no box" for thread ROWS (always a little icon, with the exact
     same styling); the lane's header icons stay plain.
   - The stock harness (DSH settings sections, popups, modals) is reskinned to these by CSS only (`skin-harness.css`);
     never by editing @deepseek-ai packages or pinned stock-app copies.
   - Every right-hand launcher has a one-line description and is 70px outside (68px head + ring), in all three tabs.
     The tab IS the colour: border/ring of every launcher under the triangle mint, square blue, circle violet; the
     selected tab icon and the menu heading light in it. Opening an app from the menu keeps the owner's lane widths
     (shell `selectSurface` no longer sets [1,2,0]; only a hidden centre comes back, as balanced).
   - THE CONTRACT TOKENS. Declared once, in the `:root` block of
     `packages/client/ui-layout/src/client/spatial/primitives/primitives.css`, and read everywhere else by name
     (`var(--…)`), never redeclared. The component catalogue,
     `docs/foundations/SPATIAL-CATALOGUE.md`, lists which component reads which (regenerate it with
     `./node_modules/.bin/tsx scripts/spatial-catalogue.ts --write`).

     | Token | Value | What it sets | Owner file |
     |---|---|---|---|
     | `--ak-portal-header-height` | `68px` | the floor of every portal head (launcher, disclosure, fold, stock launcher, thread row) | `spatial/primitives/primitives.css` |
     | `--ak-portal-gap` | `14px` | between portals, canvas blocks and grid cells; the menu stacks | `spatial/primitives/primitives.css` |
     | `--ak-portal-padding-inline` | `16px` | a portal head's horizontal padding | `spatial/primitives/primitives.css` |
     | `--ak-portal-content-gap` | `12px` | between a head's tile, copy and trailing area | `spatial/primitives/primitives.css` |
     | `--ak-icon-tile-size` | `30px` | the icon tile | `spatial/primitives/primitives.css` |
     | `--ak-icon-glyph-size` | `16px` | the glyph in the tile | `spatial/primitives/primitives.css` |
     | `--ak-portal-title-size` | `0.84375rem` | portal title | `spatial/primitives/primitives.css` |
     | `--ak-portal-summary-size` | `0.71875rem` | portal one-line summary | `spatial/primitives/primitives.css` |
     | `--ak-heading-size` | `1.5rem` | app header title; the Threads and menu lane headings | `spatial/primitives/primitives.css` |
     | `--ak-reading-size` | `1rem` | explanatory body copy (only where it is plainly explanation) | `spatial/primitives/primitives.css` |
     | `--ak-header-inset` | `20px` | a lane header's inset from the lane edge | `spatial/primitives/primitives.css` |
     | `--ak-corner-clearance` | `64px` | the room a header keeps clear of the lane's hot corner | `spatial/primitives/primitives.css` |
