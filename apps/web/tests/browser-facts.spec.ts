/**
 * The page asks the browser to keep her local store once her worker has attached it, records the
 * browser's true answer, and never waits on it longer than its limit.
 */
import { describe, expect, it } from 'vitest'
import {
  askToKeepLocalStore, BROWSER_FACTS_EVENT, BROWSER_FACTS_GLOBAL, recordBrowserFacts, storageKeepLine, type BrowserFacts,
} from '../src/browser-facts.ts'

describe('asking the browser to keep her local store', () => {
  it('a store already kept is not asked again (Firefox would prompt on every load)', async () => {
    let asked = 0
    const answer = await askToKeepLocalStore({ persisted: async () => true, persist: async () => { asked += 1; return true } })
    expect(answer).toEqual({ kind: 'kept', asked: false })
    expect(asked).toBe(0)
  })

  it('records a yes and a no exactly as the browser gave them', async () => {
    expect(await askToKeepLocalStore({ persisted: async () => false, persist: async () => true })).toEqual({ kind: 'kept', asked: true })
    expect(await askToKeepLocalStore({ persisted: async () => false, persist: async () => false })).toEqual({ kind: 'not-kept' })
    expect(await askToKeepLocalStore({ persist: async () => true })).toEqual({ kind: 'kept', asked: true })
  })

  it('a browser with no persist() is unsupported, not a no', async () => {
    expect(await askToKeepLocalStore(undefined)).toEqual({ kind: 'unsupported' })
    expect(await askToKeepLocalStore({ persisted: async () => false })).toEqual({ kind: 'unsupported' })
  })

  it('never blocks: a request nobody answers is recorded as unanswered after the limit', async () => {
    const started = Date.now()
    const answer = await askToKeepLocalStore({ persisted: async () => false, persist: () => new Promise<boolean>(() => {}) }, 20)
    expect(answer).toEqual({ kind: 'unanswered', reason: 'no answer within 0 s' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('a late answer is published when it comes: the timeout is only the interim fact', async () => {
    const late: unknown[] = []
    let answerNow: (value: boolean) => void = () => {}
    const answer = await askToKeepLocalStore(
      { persisted: async () => false, persist: () => new Promise<boolean>((resolve) => { answerNow = resolve }) }, 20,
      (eventual) => { late.push(eventual) },
    )
    expect(answer).toEqual({ kind: 'unanswered', reason: 'no answer within 0 s' })
    expect(late).toEqual([])
    answerNow(true)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(late).toEqual([{ kind: 'kept', asked: true }])
  })

  it('an answer in time is not published twice; a late refusal by exception is published with its reason', async () => {
    const late: unknown[] = []
    expect(await askToKeepLocalStore({ persist: async () => true }, 1_000, (eventual) => { late.push(eventual) })).toEqual({ kind: 'kept', asked: true })
    let refuse: (error: Error) => void = () => {}
    const refusing = { persist: () => new Promise<boolean>((_resolve, reject) => { refuse = reject }) }
    await askToKeepLocalStore(refusing, 10, (eventual) => { late.push(eventual) })
    refuse(new Error('SecurityError: not allowed'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(late).toEqual([{ kind: 'unanswered', reason: 'SecurityError: not allowed' }])
  })

  it('a refusal by exception is recorded with its reason, never thrown', async () => {
    const answer = await askToKeepLocalStore({ persisted: async () => { throw new Error('SecurityError: not allowed') }, persist: async () => true })
    expect(answer).toEqual({ kind: 'unanswered', reason: 'SecurityError: not allowed' })
  })

  it('every answer has one console line that says what happens to her memory', () => {
    expect(storageKeepLine({ kind: 'kept', asked: true })).toMatch(/agreed to keep/)
    expect(storageKeepLine({ kind: 'kept', asked: false })).toMatch(/already keeps/)
    expect(storageKeepLine({ kind: 'not-kept' })).toMatch(/reloads her memory from the edge/)
    expect(storageKeepLine({ kind: 'unsupported' })).toMatch(/reloads her memory from the edge/)
    expect(storageKeepLine({ kind: 'unanswered', reason: 'x' })).toMatch(/got no answer \(x\)/)
  })
})

describe('the facts are kept where the boot page or Continuity can read them', () => {
  it('records on the page global, merges, and announces each change', () => {
    const events: BrowserFacts[] = []
    const scope: Record<string, unknown> & { dispatchEvent: (event: Event) => boolean } = {
      dispatchEvent: (event: Event) => {
        expect(event.type).toBe(BROWSER_FACTS_EVENT)
        events.push((event as CustomEvent<BrowserFacts>).detail)
        return true
      },
    }
    recordBrowserFacts({ storageKeep: { kind: 'not-kept' } }, scope)
    const facts = recordBrowserFacts({ ceremonyGaps: ['WebAuthn passkeys'] }, scope)
    expect(facts).toEqual({ storageKeep: { kind: 'not-kept' }, ceremonyGaps: ['WebAuthn passkeys'] })
    expect(scope[BROWSER_FACTS_GLOBAL]).toBe(facts)
    expect(Object.isFrozen(facts)).toBe(true)
    expect(events).toEqual([{ storageKeep: { kind: 'not-kept' }, ceremonyGaps: null }, facts])
  })

  it('a scope that cannot dispatch still keeps the facts', () => {
    const scope: Record<string, unknown> = {}
    expect(recordBrowserFacts({ ceremonyGaps: [] }, scope)).toEqual({ storageKeep: null, ceremonyGaps: [] })
  })
})
