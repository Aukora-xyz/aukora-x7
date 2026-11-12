/**
 * The answer the worker page now gives for `/api/auma-live/status` (apps/web/src/spatial/
 * auma-live-facts.ts statusFromEdgeFacts: the edge's configured provider keys, the last wake from /_host/wake,
 * nothing else) makes exactly those two facts known on the strip. Everything the edge cannot establish stays unknown.
 * Review: a configured key is said as configured, never as a hand that resolves.
 */
import { describe, expect, it } from 'vitest'
import { aumaStatusOf, UNKNOWN_TEXT } from '../src/client/spatial/auma-status.ts'

/** The page's answer for two keyed doors and a successful wake, as statusFromEdgeFacts builds it. */
const pageAnswer = {
  source: 'page: from edge facts',
  edgeProviderKeys: ['anthropic', 'openrouter'],
  lastWake: { decision: 'probe succeeded', at: '2025-11-11T22:13:20.000Z' },
}

describe('the strip over the page-built answer', () => {
  it('hands and last wake are known; thread, CORE, spend and waiting stay unknown', () => {
    const status = aumaStatusOf({ answer: pageAnswer })
    expect(status.hands).toEqual({ known: true, text: '2 edge provider keys configured' })
    expect(status.hands.text).not.toMatch(/resolvable/)
    expect(status.wake).toEqual({ known: true, text: 'last wake: probe succeeded' })
    for (const fact of [status.thread, status.core, status.spend, status.waiting]) {
      expect(fact).toEqual({ known: false, text: UNKNOWN_TEXT })
    }
    expect(status.anyUnknown).toBe(true)
  })

  it('a resolver\'s own hands answer still wins; one key is said in the singular', () => {
    expect(aumaStatusOf({ answer: { hands: ['a'], edgeProviderKeys: ['a', 'b'] } }).hands).toEqual({ known: true, text: '1 hand resolvable' })
    expect(aumaStatusOf({ answer: { edgeProviderKeys: ['openrouter'] } }).hands).toEqual({ known: true, text: '1 edge provider key configured' })
    expect(aumaStatusOf({ answer: { edgeProviderKeys: 'openrouter' } }).hands.known).toBe(false)
  })

  it('a page answer with no facts leaves every fact unknown, and the frame\'s own lane count still shows', () => {
    // The page's answer when neither edge fact could be read: only its `source` label, no fact field at all.
    const status = aumaStatusOf({ answer: {}, lanesRunning: 2 })
    expect(status.hands.known).toBe(false)
    expect(status.wake.known).toBe(false)
    expect(status.lanes).toEqual({ known: true, text: '2' })
  })
})
