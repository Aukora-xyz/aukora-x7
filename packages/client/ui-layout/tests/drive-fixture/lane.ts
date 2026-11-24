/**
 * A faked lane for the drive's scroll specs. jsdom does no layout: every rect is made up here, so these
 * specs prove WHICH element is scrolled, by how much relative to the rects given, and that the page itself is never
 * moved; they prove nothing about pixels on a real screen.
 *
 * The lane's scroller is the app's `.ak-app` (primitives.css gives it `overflow: auto`; jsdom loads no stylesheet, so
 * the one declaration the drive reads is put on the page here, and `APP_SCROLLER_RULE` is checked against the sheet).
 */
import { vi, type MockInstance } from 'vitest'

export const APP_SCROLLER_RULE = /\.ak-app \{[^}]*overflow: auto;/u

/** A rect as the fake layout gives it (top and height; width defaults to 300). */
export interface FakeBox { readonly top: number; readonly height?: number; readonly width?: number }

export interface ScrollCall { readonly lane: boolean; readonly top: number | undefined; readonly behavior: unknown }

/**
 * What `fakeLane` hands back. Named here because the host build emits declarations for this file, and an inferred
 * mock type is not portable.
 */
export interface FakeLane {
  readonly scrolls: ScrollCall[]
  readonly intoView: MockInstance
  readonly page: MockInstance
  restore(): void
}

/**
 * Install the fake layout.
 * @param boxOf - the rect for a node, or undefined for jsdom's own (all zero).
 * @param scroller - the lane scroller's own numbers.
 */
export function fakeLane(
  boxOf: (node: Element) => FakeBox | undefined,
  scroller: { readonly scrollTop?: number; readonly clientHeight?: number } = {},
): FakeLane {
  const style = document.createElement('style')
  style.textContent = '.ak-app { overflow-y: auto; }'
  document.head.append(style)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    // Any other node gets jsdom's own answer: a rect of zeros.
    const box = boxOf(this) ?? { top: 0, height: 0, width: 0 }
    const height = box.height ?? 40
    const width = box.width ?? 300
    return { x: 0, y: box.top, top: box.top, left: 0, right: width, bottom: box.top + height, width, height, toJSON: () => ({}) }
  })
  const numbers = (node: Element): void => {
    if (!node.matches('.ak-app') || Object.prototype.hasOwnProperty.call(node, 'clientHeight')) return
    Object.defineProperty(node, 'scrollTop', { configurable: true, get: () => scroller.scrollTop ?? 0, set: () => {} })
    Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => scroller.clientHeight ?? 0 })
  }
  const scrolls: ScrollCall[] = []
  const scrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(this: Element, options?: ScrollToOptions) {
      scrolls.push({ lane: this.matches('.ak-app') && this.querySelector('[data-media-drive]') !== null, top: options?.top, behavior: options?.behavior })
    },
  })
  const intoView = vi.fn()
  const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: intoView })
  const page = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  // The scroller's own numbers are set once it exists (the app mounts after this is installed).
  const observer = new MutationObserver(() => { for (const node of document.querySelectorAll('.ak-app')) numbers(node) })
  observer.observe(document.body, { childList: true, subtree: true })
  for (const node of document.querySelectorAll('.ak-app')) numbers(node)
  return {
    scrolls,
    intoView,
    page,
    restore(): void {
      observer.disconnect()
      style.remove()
      if (scrollTo === undefined) delete (Element.prototype as Partial<Element>).scrollTo
      else Object.defineProperty(Element.prototype, 'scrollTo', scrollTo)
      if (scrollIntoView === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
      else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
    },
  }
}
