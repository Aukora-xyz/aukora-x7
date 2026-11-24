/**
 * THE SEVEN WORD TILES, SHARED BY TWO SCREENS.
 *
 * `AnchorBox`, `TileBody` and `PhraseBand` are the AUMLOK screen's own tiles, moved here unchanged so the Identity
 * screen's invite panel takes the words in the same pinned look; `AumlokSurface.tsx` renders them exactly as before.
 * `AumlokWordInput` is the INPUT FACE ONLY, for a screen that asks for the words in use and never shows them back: the
 * gold anchor card with its one input, then the three bands of two rows each. It holds nothing itself; the caller owns
 * the typed words and clears them.
 */
import type { AumlokKey } from './locales.ts'
import {
  AUMLOK_ANCHOR_POSITION,
  AUMLOK_BANDS,
  aumlokWordInitial,
  type AumlokAnchorBox,
  type AumlokBandSpec,
  type AumlokTileFace,
} from './surface-state.ts'
import css from './AumlokFace.module.css'

/** The AUMLOK dictionary lookup the tiles' labels go through. */
export type Translate = (key: AumlokKey) => string

/**
 * ONE OF THE ANCHOR CARD'S SIX BOXES. A letter while the words are on the screen, a dot once they are
 * a binding, and nothing at all before then — the three faces are decided by `aumlokAnchorBoxes`, so a
 * box cannot invent a fourth.
 */
export function AnchorBox({ box, index }: { box: AumlokAnchorBox; index: number }) {
  return (
    <span className={css.anchorBox} data-aumlok-anchor-box={index} data-aumlok-anchor-box-kind={box.kind}>
      {box.kind === 'letter' ? box.letter : box.kind === 'dot' ? <i className={css.anchorDot} /> : null}
    </span>
  )
}

/**
 * WHAT ONE THEMED ROW SHOWS. There is one body per face and no others: an empty slot, dots where a
 * bound phrase is never shown, the drawn word for the one beat it is on the screen, and the input that
 * takes it back. The face itself comes from `aumlokTileFace`, so no row can invent a state the layout
 * does not have.
 */
export function TileBody({
  face,
  position,
  word,
  value,
  dots,
  onType,
  t,
}: {
  face: AumlokTileFace
  position: number
  word: string | undefined
  value: string
  dots: number
  onType: (position: number, value: string) => void
  t: Translate
}) {
  switch (face) {
    case 'empty':
      return <span className={css.tileEmpty} data-aumlok-tile-face="empty" aria-hidden="true">—</span>
    case 'dots':
      return (
        <span className={css.wordMask} data-aumlok-tile-face="dots" aria-hidden="true">
          {Array.from({ length: dots }, (_, index) => <i key={index} />)}
        </span>
      )
    case 'word':
      return <span className={css.tileWord} data-aumlok-tile-face="word">{word ?? ''}</span>
    case 'input':
      return (
        <input
          className={css.tileInput}
          data-aumlok-tile-face="input"
          data-aumlok-tile-input={position}
          value={value}
          onChange={(event) => { onType(position, event.target.value) }}
          aria-label={t('tile.input').replace('{position}', String(position))}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      )
  }
}

/** The one shape a band's two rows take, from the same face as the anchor above them. */
export function PhraseBand({
  band,
  face,
  words,
  typed,
  onType,
  t,
}: {
  band: AumlokBandSpec
  face: AumlokTileFace
  words: readonly string[] | undefined
  typed: readonly string[]
  onType: (position: number, value: string) => void
  t: Translate
}) {
  return (
    <section className={css.phraseBand} data-aumlok-band={band.id} data-aumlok-tone={band.tone}>
      <header className={css.bandHeader}>
        <strong>{t(band.label)}</strong>
        <span>{t(band.detail)}</span>
      </header>
      <div className={css.bandRows}>
        {band.positions.map(position => (
          <div className={css.phraseRow} data-aumlok-token={position} key={position}>
            {/* The number is optional and quiet, and it is never read out: it is an aid to the eye. */}
            <span className={css.position} aria-hidden="true">{position}</span>
            {/* THE SMALL GOLD BOX, holding this word's FIRST letter and nothing once the words are
                gone: the six initials spell the anchor, so a bound row that kept them would publish
                the phrase one letter at a time. */}
            <span className={css.initialBox} data-aumlok-initial-box={position} aria-hidden="true">
              {aumlokWordInitial(face, words?.[position])}
            </span>
            <TileBody
              face={face}
              position={position}
              word={words?.[position]}
              value={typed[position] ?? ''}
              dots={5}
              onType={onType}
              t={t}
            />
            {face === 'dots'
              ? <span className={css.visuallyHidden}>{t('token.rowMasked')}</span>
              : null}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * THE WORDS IN USE, TYPED AND NEVER SHOWN BACK. The same anchor card and bands as the AUMLOK screen at its input face:
 * the anchor's six letter boxes are replaced by one input, and each band row takes one word. Nothing is drawn from the
 * typed words except what the person types into each input.
 * @param props - the typed words (seven entries), the change handler, and the dictionary lookup.
 * @returns the anchor card and the three bands.
 */
export function AumlokWordInput({
  typed,
  onType,
  t,
}: {
  typed: readonly string[]
  onType: (position: number, value: string) => void
  t: Translate
}) {
  return (
    <>
      <div className={css.anchorToken} data-aumlok-token={AUMLOK_ANCHOR_POSITION} data-aumlok-anchor-card data-aumlok-tile-face="input">
        <span className={css.anchorMeta}>
          <strong>{t('anchor.label')}</strong>
          <span>{t('anchor.detail')}</span>
        </span>
        <span className={css.anchorBoxes}>
          <input
            className={css.anchorInput}
            data-aumlok-tile-input={AUMLOK_ANCHOR_POSITION}
            data-aumlok-anchor-input
            value={typed[AUMLOK_ANCHOR_POSITION] ?? ''}
            onChange={(event) => { onType(AUMLOK_ANCHOR_POSITION, event.target.value) }}
            aria-label={t('tile.input').replace('{position}', String(AUMLOK_ANCHOR_POSITION))}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </span>
      </div>
      <div className={css.bands}>
        {AUMLOK_BANDS.map(band => (
          <PhraseBand band={band} face="input" words={undefined} typed={typed} onType={onType} t={t} key={band.id} />
        ))}
      </div>
    </>
  )
}
