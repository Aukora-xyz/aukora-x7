/**
 * Her voice map (src/x6/voice-map.ts). Sections, order, bounds, determinism, the missing-section
 * marker, the secret and private screens, no persona sentence, and "since your last voice turn".
 */
import { describe, expect, it } from 'vitest'
import {
  handoffTop, renderVoiceMap, seenOf, sinceLines, VOICE_MAP_HANDOFF_CHARS, VOICE_MAP_HEADER, VOICE_MAP_MAX_BYTES,
  VOICE_MAP_NOW_CHARS, VOICE_MAP_SECTION_BYTES, type VoiceMapFacts,
} from '../../src/x6/voice-map.ts'

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength

const tool = (name: string, readOnly: boolean): { name: string; readOnly: boolean; description: string } =>
  ({ name, readOnly, description: `${name} does one thing. More words that are not carried.` })

const world = (over: Partial<VoiceMapFacts> = {}): VoiceMapFacts => ({
  build: { id: 'abcd1234', builtAt: '2026-11-14T02:00:00Z' },
  epoch: 170,
  ballId: 'f'.repeat(64),
  level: 'open',
  body: { organs: 12, organsDiffer: 1, pinnedCells: 9, cells: 9, forgedCells: 2, skills: 3, threads: 5 },
  motion: { cord: [{ skill: 'fifo24', head: 'a'.repeat(64), tick: 7 }], wish: { first: '# Wish: learn the tracker', lines: 4 } },
  continuity: {
    handoff: 'I left the cord at tick 7. Next: read YOURTEAM-398.',
    awareness: { keys: ['entries', 'schema'], newest: '{"at":"2026-11-14","note":"voice map landed"}' },
  },
  tools: [tool('x6_threads', true), tool('x6_repo', true), tool('x6_self_state', true), tool('x6_linear', false),
    tool('x6_exec', false), tool('x6_cell', false), tool('auma_snapshot', false)],
  ...over,
})

const ORDER = ['since your last voice turn:', 'where:', 'body:', 'in motion:', 'continuity (her own files):',
  'hands, look (read-only):', 'hands, act:', 'to look deeper:']

describe('the voice map', () => {
  it('every section is present with a fixture world, in the fixed order, under the header', () => {
    const map = renderVoiceMap(world(), ['first voice turn since the page loaded build abcd1234 (epoch 170).'])
    expect(map.startsWith(VOICE_MAP_HEADER)).toBe(true)
    const at = ORDER.map(heading => map.indexOf(heading))
    for (const index of at) expect(index).toBeGreaterThan(0)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(map).toContain('build abcd1234, built 2026-11-14T02:00:00Z; head epoch 170')
    expect(map).toContain('organs 12 (1 differ from her store); pinned cells 9')
    expect(map).toContain('cord fifo24: head aaaaaaaaaaaa, tick 7.')
    expect(map).toContain('I left the cord at tick 7.')
    expect(map).toContain('AWARENESS.v1.json keys: entries, schema.')
    expect(map).toContain('- x6_linear: x6_linear does one thing.')
    expect(map).not.toContain('More words that are not carried')
    expect(map).not.toContain('not read in time')
  })

  it('look and act come from the index: a read-only tool is under look, a writer under act, her x6_ doors first', () => {
    const map = renderVoiceMap(world(), [])
    const look = map.slice(map.indexOf('hands, look'), map.indexOf('hands, act'))
    const act = map.slice(map.indexOf('hands, act'), map.indexOf('to look deeper:'))
    expect(look).toContain('x6_repo')
    expect(look).not.toContain('x6_exec')
    expect(act).toContain('x6_exec')
    expect(act.indexOf('x6_linear')).toBeLessThan(act.indexOf('auma_snapshot'))
    expect(map).toContain('all tool names: auma_snapshot, x6_cell')
  })

  it('is deterministic and bounded: total and each section under its cap, even with a huge world', () => {
    const huge = world({
      continuity: { handoff: 'word '.repeat(5000), awareness: { keys: Array.from({ length: 24 }, (_, i) => `key${String(i)}`), newest: 'x '.repeat(4000) } },
      tools: Array.from({ length: 400 }, (_, i) => tool(`x6_tool_${String(i).padStart(3, '0')}`, i % 2 === 0)),
    })
    const since = ['a', 'b', 'c', 'd', 'e'].map(letter => `${letter} `.repeat(200))
    const first = renderVoiceMap(huge, since)
    expect(renderVoiceMap(huge, since)).toBe(first)
    expect(bytes(first)).toBeLessThanOrEqual(VOICE_MAP_MAX_BYTES)
    const sliceOf = (from: string, to: string): string => first.slice(first.indexOf(from), first.indexOf(to))
    expect(bytes(sliceOf('since your last', '\nwhere:'))).toBeLessThanOrEqual(VOICE_MAP_SECTION_BYTES.since)
    expect(bytes(sliceOf('continuity (her own files):', '\nall tool names'))).toBeLessThanOrEqual(VOICE_MAP_SECTION_BYTES.continuity)
    expect(bytes(sliceOf('all tool names', '\nto look deeper:'))).toBeLessThanOrEqual(VOICE_MAP_SECTION_BYTES.hands)
    expect(first).toContain('hands, act:')
    expect(first).toContain('to look deeper:')
  })

  it('a section not read in time is left out and one line says so', () => {
    const map = renderVoiceMap(world({ body: null, continuity: null }), [])
    expect(map).not.toContain('body:')
    expect(map).not.toContain('continuity (her own files):')
    expect(map).toContain('not read in time: body, continuity.')
    expect(map).toContain('in motion:')
  })

  it('a missing file is said plainly; nothing from her private folder; a planted secret is screened', () => {
    const planted = 'sk-' + 'Q'.repeat(30)
    const map = renderVoiceMap(world({
      continuity: { handoff: `key ${planted} and nsec1${'q'.repeat(20)} at /dsh/home/auma/private/notes.md`, awareness: null },
      motion: { cord: [], wish: { first: `wish ${'A1'.repeat(30)}`, lines: 1 } },
    }), [])
    expect(map).not.toContain(planted)
    expect(map).not.toContain('nsec1')
    expect(map).not.toContain('/dsh/home/auma/private')
    expect(map).not.toContain('A1A1A1A1A1A1A1A1A1A1A1A1')
    expect(map).toContain('[withheld]')
    expect(map).toContain('AWARENESS.v1.json: absent.')
    expect(map).toContain('cord: not started.')
  })

  it('no persona: no sentence tells her who she is, how to sound or what to do', () => {
    const map = renderVoiceMap(world(), sinceLines(null, seenOf(world(), {})))
    for (const line of map.split('\n')) {
      expect(line).not.toMatch(/\byou are\b|\byou should\b|\byou must\b|\bbe (warm|brief|kind|yourself)\b|\bsound\b|\bspeak\b/i)
      expect(line).not.toMatch(/\bremember to\b|\blook before\b|\bask\b|\banswer\b|\bpersona\b/i)
      expect(line).not.toMatch(/^(Be|Do|Don't|Never|Always|Say|Tell|Use|Read|Answer|Look) /)
    }
  })
})

describe('since your last voice turn', () => {
  const base = seenOf(world(), { t1: 'Morning build', t2: 'Voice' })

  it('first turn since the page loaded: one line naming the build', () => {
    expect(sinceLines(null, base)).toEqual(['first voice turn since the page loaded build abcd1234 (epoch 170).'])
  })

  it('an unchanged world gives no section', () => {
    expect(sinceLines(base, seenOf(world(), { t2: 'Voice', t1: 'Morning build' }))).toEqual([])
    expect(renderVoiceMap(world(), [])).not.toContain('since your last voice turn')
  })

  it('a new build, a new thread, the cord advanced and the wish ended, at most five lines', () => {
    const next = seenOf(world({ build: { id: 'beef5678', builtAt: null }, epoch: 171,
      motion: { cord: [{ skill: 'fifo24', head: 'b'.repeat(64), tick: 9 }], wish: null } }),
    { t1: 'Morning build', t2: 'Voice', t3: 'Tracker sweep' })
    const lines = sinceLines(base, next)
    expect(lines).toEqual([
      'new build: abcd1234 -> beef5678.',
      'head epoch moved: 170 -> 171.',
      'new threads: "Tracker sweep".',
      'cord advanced: tick 7 -> 9.',
      'the active wish ended.',
    ])
    const more = seenOf(world({ build: { id: 'c0ffee00', builtAt: null }, epoch: 172,
      motion: { cord: [{ skill: 'fifo24', head: 'c'.repeat(64), tick: 11 }], wish: null } }),
    { t1: 'Renamed', t2: 'Voice', t3: 'Tracker sweep', t4: 'Another' })
    expect(sinceLines(next, more).length).toBeLessThanOrEqual(5)
  })
  it('review: with her real 21 doors and long descriptions, every door keeps its own line under look or act', () => {
    const LOOK = ['x6_browser_estate', 'x6_capability_index', 'x6_host_facts', 'x6_repo', 'x6_self_check', 'x6_self_state',
      'x6_threads', 'x6_trusted_docs', 'x6_voice_probe', 'x6_voice_status']
    const ACT = ['x6_cell', 'x6_cloudflare', 'x6_consult', 'x6_exec', 'x6_github', 'x6_linear', 'x6_nostr', 'x6_skill',
      'x6_swarm', 'x6_web_eyes', 'x6_wish']
    const long = (name: string, readOnly: boolean): { name: string; readOnly: boolean; description: string } =>
      ({ name, readOnly, description: `A door that does a long list of things for ${name}, described at length with many words and clauses that keep going. More.` })
    const map = renderVoiceMap(world({ tools: [...LOOK.map(n => long(n, true)), ...ACT.map(n => long(n, false))] }), [])
    const look = map.slice(map.indexOf('hands, look'), map.indexOf('hands, act'))
    const act = map.slice(map.indexOf('hands, act'), map.indexOf('to look deeper:'))
    for (const name of LOOK) expect(look).toMatch(new RegExp(`^- ${name}(:|$)`, 'm'))
    for (const name of ACT) expect(act).toMatch(new RegExp(`^- ${name}(:|$)`, 'm'))
    expect(bytes(map.slice(map.indexOf('all tool names'), map.indexOf('\nto look deeper:')))).toBeLessThanOrEqual(VOICE_MAP_SECTION_BYTES.hands)
  })

  it('review: when even bare names cannot all have a line, a tail line says how many more and names them', () => {
    const many = Array.from({ length: 400 }, (_, i) => tool(`x6_door_${String(i).padStart(3, '0')}`, i % 2 === 0))
    const map = renderVoiceMap(world({ tools: many }), [])
    expect(map).toMatch(/^- and \d+ more: x6_door_/m)
    expect(bytes(map)).toBeLessThanOrEqual(VOICE_MAP_MAX_BYTES)
  })
})

describe('voicelane1: the top of her hand-off note rides every open voice turn', () => {
  const NOTE = [
    '# HANDOFF',
    'Old history line one.',
    '',
    '## Where I am now',
    'Mid-card on YOURTEAM-512: wiring the tracker sweep. Waiting on the gate.',
    '',
    '### detail',
    'Sub-point kept with its section.',
    '',
    '## Earlier',
    'Not carried: an older section.',
  ].join('\n')

  it('her own "Where I am now" section, whole, when the note has one (its subsections with it, the next section not)', () => {
    const top = handoffTop(NOTE)
    expect(top.startsWith('## Where I am now')).toBe(true)
    expect(top).toContain('Mid-card on YOURTEAM-512')
    expect(top).toContain('Sub-point kept with its section.')
    expect(top).not.toContain('Not carried')
    expect(top).not.toContain('Old history line one.')
    const map = renderVoiceMap(world({ continuity: { handoff: NOTE, awareness: null } }), [])
    expect(map).toContain('Mid-card on YOURTEAM-512')
    expect(map).not.toContain('Not carried')
  })

  it('no such section: the first VOICE_MAP_NOW_CHARS (2,000) characters; a long section is cut to the same', () => {
    expect(VOICE_MAP_NOW_CHARS).toBe(2000)
    const plain = 'a'.repeat(1990) + 'b'.repeat(500)
    expect(handoffTop(plain)).toBe('a'.repeat(1990) + 'b'.repeat(10))
    const long = `## Where I am now\n${'c'.repeat(5000)}`
    expect(handoffTop(long).length).toBe(2000)
    // The worker reads enough of the file to find a section that starts past the first 2,000 characters.
    expect(VOICE_MAP_HANDOFF_CHARS).toBeGreaterThanOrEqual(8192)
    const late = `${'x'.repeat(4000)}\n## Where I am now\nlate and found`
    expect(handoffTop(late)).toBe('## Where I am now\nlate and found')
  })

  it('the now section sits after where and before body, under its own cap; the total stays under VOICE_MAP_MAX_BYTES', () => {
    const map = renderVoiceMap(world({ continuity: { handoff: NOTE, awareness: null } }), [])
    const at = ['where:', 'her hand-off note, top', 'body:', 'continuity (her own files):'].map(h => map.indexOf(h))
    for (const index of at) expect(index).toBeGreaterThan(0)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    const huge = renderVoiceMap(world({ continuity: { handoff: `## Where I am now\n${'word '.repeat(4000)}`, awareness: null } }), [])
    const section = huge.slice(huge.indexOf('her hand-off note, top'), huge.indexOf('\nbody:'))
    expect(bytes(section)).toBeLessThanOrEqual(VOICE_MAP_SECTION_BYTES.now)
    expect(bytes(huge)).toBeLessThanOrEqual(VOICE_MAP_MAX_BYTES)
    expect(huge).toContain('to look deeper:')
  })

  it('the section is screened: a secret or a private path in her note never rides the voice turn', () => {
    const planted = 'sk-' + 'Z'.repeat(30)
    const map = renderVoiceMap(world({ continuity: { handoff: `## Where I am now\nkey ${planted} in /dsh/home/auma/private/x.md`, awareness: null } }), [])
    expect(map).not.toContain(planted)
    expect(map).not.toContain('/dsh/home/auma/private')
  })
})
