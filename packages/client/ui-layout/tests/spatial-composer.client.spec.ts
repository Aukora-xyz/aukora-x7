/**
 * The Spatial frame's two rules for the composer (after Round 32). They are plain CSS, so they are pinned by what they
 * say: the band rule must outweigh the harness's own composer-seat rule (a tie lets load order decide, and the harness
 * won), and the stats rule must name the attribute the stats pills really carry (ui-chat StatsPills `data-composer-stat`).
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (file: string): string => {
  const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}${file}`)).find(existsSync)
  if (path === undefined) throw new Error(`not found: ${file}`)
  return readFileSync(path, 'utf8')
}
const FRAME = read('packages/client/ui-layout/src/client/spatial/SpatialFrame.module.css')
const HARNESS = read('packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css')
const PILLS = read('packages/client/ui-chat/src/client/chat/StatsPills.tsx')
const SEAT = read('packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx')

/** Specificity of a simple selector of classes, attributes and descendants: [ids, classes + attributes, types]. */
const weight = (selector: string): number => (selector.match(/\.[\w-]+|\[[^\]]+\]/gu) ?? []).length

describe('the composer in the Spatial frame (after Round 32)', () => {
  it('the frame clears the composer seat with a rule that outweighs the harness seat rule, on the seat the harness renders', () => {
    const harness = /\.root\[data-phase='active'\] \.composerSeat/u.exec(HARNESS)?.[0] ?? ''
    expect(harness).not.toBe('')
    const match = /([^\n{}]*\[data-composer-seat\][^\n{},]*)[\s\S]*?\{([^}]*)\}/u.exec(FRAME)
    const frame = match?.[1]?.trim() ?? ''
    const body = match?.[2] ?? ''
    expect(frame).toContain("[data-conversation-region='composer']")
    expect(body).toContain('background: none;')
    expect(body).not.toMatch(/\bposition\s*:/u)
    expect(HARNESS).toMatch(/\.root\[data-phase='active'\] \.composerSeat,[\s\S]*?\{\s*position: sticky;\s*bottom: 0;/u)
    expect(weight(frame)).toBeGreaterThan(weight(harness))
    expect(SEAT).toContain('data-composer-seat="" data-conversation-region="composer"')
  })
  it('in the one-line header the name keeps a floor and the centre group yields first in a narrow lane', () => {
    const CONVERSATION = read('packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css')
    expect(CONVERSATION).toMatch(/grid-template-columns: minmax\(min\(9rem, 60%\), 1fr\) minmax\(0, auto\) minmax\(0, 1fr\);/u)
    expect(CONVERSATION).toMatch(/\.headerCenter \{[^}]*min-width: 0;[^}]*overflow: hidden;/u)
  })
  it('the stats rule names the attribute the stats pills carry', () => {
    expect(PILLS).toContain('data-composer-stat={stat}')
    expect(FRAME).toMatch(/\.frame \[data-composer-stat\] \{\s*display: none;/u)
    expect(FRAME).not.toContain('[data-composer-stats]')
  })
})
