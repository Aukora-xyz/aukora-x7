// @vitest-environment jsdom
/**
 * What this browser cannot do for her, and whether it agreed to keep her local
 * store, are said on the boot page in plain words while she starts. They never stop or fail the boot.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BOOT_PHASE_EVENT, BootPage, BROWSER_FACTS_EVENT, browserFactNotes } from '../src/boot-page.ts'

afterEach(() => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(globalThis, '__AUKORA_BROWSER__')
})

function mount(options: ConstructorParameters<typeof BootPage>[1] = {}) {
  const el = document.createElement('div')
  document.body.append(el)
  const events = new EventTarget()
  return { el, events, page: new BootPage(el, { events, ...options }) }
}

const facts = (detail: unknown): CustomEvent => new CustomEvent(BROWSER_FACTS_EVENT, { detail })
const notes = (el: HTMLElement): string[] => [...el.querySelectorAll('[data-dsh-boot-note]')].map(node => node.textContent ?? '')

describe('browserFactNotes', () => {
  it('names the missing ceremony capabilities and what she cannot do without them', () => {
    expect(browserFactNotes({ ceremonyGaps: ['WebAuthn passkeys'] }, true)).toEqual([
      'She runs in this browser, but it lacks WebAuthn passkeys, so you cannot bind her or approve her changes in it.',
    ])
    expect(browserFactNotes({ ceremonyGaps: ['WebCrypto Ed25519', 'WebAuthn passkeys', 'WebCrypto digests'] }, true)).toEqual([
      'She runs in this browser, but it lacks WebCrypto Ed25519, WebAuthn passkeys and WebCrypto digests, so you cannot bind her or approve her changes in it and her Wasm cells cannot run in it.',
    ])
  })

  it('on a page not served over HTTPS it says why the browser withholds them', () => {
    expect(browserFactNotes({ ceremonyGaps: ['WebAuthn passkeys', 'WebCrypto digests'] }, false)).toEqual([
      'She runs in this browser, but it lacks WebAuthn passkeys and WebCrypto digests, so you cannot bind her or approve her changes in it and her Wasm cells cannot run in it. This page is not served over HTTPS, and browsers withhold these from such pages.',
    ])
  })

  it('says the browser\'s true answer about keeping her local store', () => {
    expect(browserFactNotes({ storageKeep: { kind: 'kept', asked: true } }, true)).toEqual(['This browser keeps her local store.'])
    expect(browserFactNotes({ storageKeep: { kind: 'kept', asked: false } }, true)).toEqual(['This browser keeps her local store.'])
    expect(browserFactNotes({ storageKeep: { kind: 'not-kept' } }, true)).toEqual([
      'This browser did not agree to keep her local store; if it clears it, she reloads her memory from the edge.'])
    expect(browserFactNotes({ storageKeep: { kind: 'unsupported' } }, true)).toEqual([
      'This browser cannot be asked to keep her local store; if it clears it, she reloads her memory from the edge.'])
    expect(browserFactNotes({ storageKeep: { kind: 'unanswered', reason: 'x' } }, true)).toEqual([
      'This browser has not said whether it will keep her local store.'])
  })

  it('nothing known, nothing missing, or anything unrecognised says nothing', () => {
    expect(browserFactNotes(undefined, true)).toEqual([])
    expect(browserFactNotes({ storageKeep: null, ceremonyGaps: null }, true)).toEqual([])
    expect(browserFactNotes({ ceremonyGaps: [] }, false)).toEqual([])
    expect(browserFactNotes({ ceremonyGaps: ['<b>made up</b>', 7], storageKeep: { kind: 'other' } }, true)).toEqual([])
  })
})

describe('the boot page says them while she starts', () => {
  it('a facts event adds the notes under the hint; the spinner stays and nothing fails', () => {
    const { el, events } = mount({ secureContext: true })
    events.dispatchEvent(facts({ storageKeep: null, ceremonyGaps: ['WebAuthn passkeys'] }))
    expect(notes(el)).toEqual(['She runs in this browser, but it lacks WebAuthn passkeys, so you cannot bind her or approve her changes in it.'])
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
    events.dispatchEvent(facts({ storageKeep: { kind: 'not-kept' }, ceremonyGaps: ['WebAuthn passkeys'] }))
    expect(notes(el)).toHaveLength(2)
    expect(notes(el)[1]).toMatch(/did not agree to keep her local store/)
  })

  it('facts recorded before the boot page existed are shown from the page global', () => {
    Reflect.set(globalThis, '__AUKORA_BROWSER__', { storageKeep: { kind: 'unsupported' }, ceremonyGaps: [] })
    const { el } = mount({ secureContext: true })
    expect(notes(el)).toEqual(['This browser cannot be asked to keep her local store; if it clears it, she reloads her memory from the edge.'])
  })

  it('the notes survive a boot step and stay beside the still-starting notice', async () => {
    const { el, events } = mount({ secureContext: true, stallMs: 5 })
    events.dispatchEvent(facts({ storageKeep: { kind: 'kept', asked: true } }))
    events.dispatchEvent(new CustomEvent(BOOT_PHASE_EVENT, { detail: { phase: 'storage' } }))
    expect(notes(el)).toEqual(['This browser keeps her local store.'])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(el.querySelector('[data-dsh-boot-stalled]')).not.toBeNull()
    expect(notes(el)).toEqual(['This browser keeps her local store.'])
  })

  it('after the handoff the page stops listening', () => {
    const { el, events, page } = mount({ secureContext: true })
    page.handoff()
    events.dispatchEvent(facts({ storageKeep: { kind: 'not-kept' } }))
    expect(notes(el)).toEqual([])
    page.dispose()
  })
})
