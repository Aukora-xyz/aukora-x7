// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_PHASE_EVENT, BootPage } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.textContent).toContain('HARNESS')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })
})

// The boot stall: the page sat on "Loading plugins…" forever when the network dropped during boot.
describe('BootPage: boot steps, a still-starting notice with Reload, never a failure while things arrive', () => {
  afterEach(() => { vi.useRealTimers() })
  function staged(stallMs = 1000) {
    vi.useFakeTimers()
    const el = document.createElement('div')
    document.body.append(el)
    const events = new EventTarget()
    const reload = vi.fn()
    const page = new BootPage(el, { stallMs, reload, events })
    const phase = (name: string, bytes?: number) => {
      events.dispatchEvent(new CustomEvent(BOOT_PHASE_EVENT, { detail: { phase: name, ...(bytes === undefined ? {} : { bytes }) } }))
    }
    return { el, page, phase, reload }
  }

  it.each([
    ['image', 'fetching her seed image'], ['storage', 'opening her memory'], ['plugins', 'loading her plugins'],
    ['head', 'reading her head'], ['serving', 'loading her plugins'],
  ])('silence in phase %s says she is still starting, how long, with Reload as an option (never a verdict)', (name, doing) => {
    const { el, phase, reload } = staged()
    phase(name)
    vi.advanceTimersByTime(999)
    expect(el.querySelector('[data-dsh-boot-stalled]')).toBeNull()
    vi.advanceTimersByTime(2)
    expect(el.textContent).toContain(`She is still starting (1 s so far, ${doing}). Nothing new for a while; you can wait or reload.`)
    expect(el.textContent).not.toMatch(/could not load|failed/i)
    // The spinner stays: she is still starting.
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    el.querySelector<HTMLButtonElement>('[data-dsh-boot-reload]')?.click()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  // Legitimate plugin activation can be silent for longer than the stall window.
  it('a long silent plugin activation is "still starting" with the time so far and the activation count', () => {
    const { el, page, phase } = staged(45_000)
    phase('serving')
    page.setTotal(12)
    page.setState('a', 'active')
    page.setState('b', 'active')
    expect(el.textContent).toContain('Loading plugins… 2/12')
    vi.advanceTimersByTime(45_001)
    expect(el.textContent).toContain('She is still starting (45 s so far, loading her plugins)')
    vi.advanceTimersByTime(30_000)
    expect(el.textContent).toContain('She is still starting (75 s so far, loading her plugins)')
    expect(el.textContent).not.toMatch(/could not load|failed/i)
    page.setState('c', 'active')
    expect(el.querySelector('[data-dsh-boot-stalled]')).toBeNull()
    expect(el.textContent).toContain('Loading plugins… 3/12')
  })

  // A healthy 10 KiB/s download whose worker reports bytes on a 5 s heartbeat.
  it('a 10 KiB/s download reported every 5 s never shows the notice at the real 45 s window', () => {
    const { el, phase } = staged(45_000)
    for (let second = 5; second <= 300; second += 5) {
      vi.advanceTimersByTime(5_000)
      phase('image', second * 10 * 1024)
      expect(el.querySelector('[data-dsh-boot-stalled]')).toBeNull()
    }
  })

  // Nothing of the boot page keeps observing once the renderer has the mount point.
  it('handoff stops the stall clock and the boot-step listener; a mounted app never sees a notice', () => {
    const { el, page, phase } = staged()
    phase('serving')
    page.handoff()
    expect(vi.getTimerCount()).toBe(0)
    const before = el.textContent
    phase('image', 50 * 1024 * 1024)
    page.setState('late', 'active')
    vi.advanceTimersByTime(60_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(el.querySelector('[data-dsh-boot-stalled]')).toBeNull()
    expect(el.textContent).not.toContain('50 MB')
    expect(before).toContain('Loading plugins…')
  })

  // A late failure after the handoff produced a render and DOM mutations in the detached page.
  it('after handoff no mutator renders: late setTotal, setState (even failed) and fail cause zero DOM mutations', () => {
    const { el, page } = staged()
    page.setTotal(3)
    page.setState('a', 'active')
    page.handoff()
    const observer = new MutationObserver(() => {})
    observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true })
    page.setTotal(9)
    page.setState('b', 'failed')
    page.setState('c', 'active')
    page.fail('late failure after mount')
    vi.advanceTimersByTime(60_000)
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
    expect(el.textContent).not.toMatch(/late failure|Failed to load/)
  })

  it('shows the step and the image bytes as they arrive', () => {
    const { el, phase } = staged()
    phase('image', 12 * 1024 * 1024)
    expect(el.textContent).toContain('Loading her seed image… 12 MB')
    phase('head')
    expect(el.textContent).toContain('Reading her head…')
  })

  it('never stalls while bytes keep arriving, and a stall notice clears when progress resumes', () => {
    const { el, phase, page } = staged()
    for (let i = 1; i <= 10; i += 1) { vi.advanceTimersByTime(900); phase('image', i * 1024 * 1024) }
    expect(el.querySelector('[data-dsh-boot-stalled]')).toBeNull()
    vi.advanceTimersByTime(1001)
    expect(el.querySelector('[data-dsh-boot-stalled]')).not.toBeNull()
    page.setState('a', 'active')
    expect(el.querySelector('[data-dsh-boot-stalled]')).toBeNull()
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
  })

  it('a named stall failure from the worker is said plainly, keeps the existing report, and offers Reload', () => {
    const { el, page, reload } = staged()
    page.fail('webworker host: BOOT_IMAGE_STALLED: no bytes for 30s while fetching her seed image')
    expect(el.textContent).toContain('She could not load: the network stopped answering while fetching her seed image. Reload to try again.')
    expect(el.textContent).toContain('Failed to load plugins')
    expect(el.textContent).toContain('BOOT_IMAGE_STALLED')
    el.querySelector<HTMLButtonElement>('[data-dsh-boot-reload]')?.click()
    expect(reload).toHaveBeenCalledTimes(1)
    // A failure stops the stall clock: no notice replaces the report later.
    vi.advanceTimersByTime(10_000)
    expect(el.querySelector('[data-dsh-boot-stalled]')).toBeNull()
  })

  it('dispose stops listening and stops the clock', () => {
    const { el, page, phase } = staged()
    page.dispose()
    phase('image')
    vi.advanceTimersByTime(10_000)
    expect(el.textContent).toBe('')
  })
})
