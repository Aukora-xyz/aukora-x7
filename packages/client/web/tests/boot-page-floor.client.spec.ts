// @vitest-environment jsdom
/**
 * A browser below the engine floor gets a plain sentence naming what it lacks, in the boot page's
 * existing failure view, instead of "Failed to load plugins" or an endless spinner.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { belowFloorSentence, BootPage, BROWSER_BELOW_FLOOR } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = '' })

describe('belowFloorSentence', () => {
  it('names one, two or three missing capabilities in plain words', () => {
    expect(belowFloorSentence(`${BROWSER_BELOW_FLOOR}: module workers`))
      .toBe('This browser cannot run her: it lacks module workers. Open her in a current Chrome, Firefox or Safari.')
    expect(belowFloorSentence(`${BROWSER_BELOW_FLOOR}: module workers, WebCrypto digests`))
      .toBe('This browser cannot run her: it lacks module workers and WebCrypto digests. Open her in a current Chrome, Firefox or Safari.')
    expect(belowFloorSentence(`${BROWSER_BELOW_FLOOR}: a, b, c`))
      .toBe('This browser cannot run her: it lacks a, b and c. Open her in a current Chrome, Firefox or Safari.')
  })

  it('an empty list still says something true', () => {
    expect(belowFloorSentence(`${BROWSER_BELOW_FLOOR}: `))
      .toBe('This browser cannot run her: it lacks a capability she needs. Open her in a current Chrome, Firefox or Safari.')
  })

  it('any other failure is not a floor failure', () => {
    expect(belowFloorSentence(undefined)).toBeUndefined()
    expect(belowFloorSentence('BOOT_IMAGE_STALLED: no bytes')).toBeUndefined()
    expect(belowFloorSentence(`worker said ${BROWSER_BELOW_FLOOR}: later in the text`)).toBeUndefined()
  })
})

describe('the boot page below the floor', () => {
  it('shows the sentence and Reload, and not "Failed to load plugins" or the raw code', () => {
    const el = document.createElement('div')
    document.body.append(el)
    let reloads = 0
    const page = new BootPage(el, { reload: () => { reloads += 1 } })
    page.fail(`${BROWSER_BELOW_FLOOR}: gzip streams (DecompressionStream)`)
    expect(el.querySelector('[data-dsh-boot-floor]')).not.toBeNull()
    expect(el.textContent).toContain('This browser cannot run her: it lacks gzip streams (DecompressionStream).')
    expect(el.textContent).not.toContain('Failed to load plugins')
    expect(el.textContent).not.toContain(BROWSER_BELOW_FLOOR)
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    el.querySelector<HTMLButtonElement>('[data-dsh-boot-reload]')?.click()
    expect(reloads).toBe(1)
    page.dispose()
  })

  it('a named load failure keeps its existing report', () => {
    const el = document.createElement('div')
    document.body.append(el)
    const page = new BootPage(el)
    page.fail('BOOT_IMAGE_STALLED: no bytes for 30 s')
    expect(el.querySelector('[data-dsh-boot-floor]')).toBeNull()
    expect(el.textContent).toContain('Failed to load plugins')
    page.dispose()
  })
})
