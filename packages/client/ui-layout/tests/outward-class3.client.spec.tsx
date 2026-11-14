/** The staged outward request is offered only when it is exactly the GitHub post the card describes. */
import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/client/spatial/aumlok/class3-approval.ts'
import { outwardWords, parseStagedOutward, STAGED_OUTWARD_SCHEMA } from '../src/client/spatial/aumlok/outward-class3.ts'

const file = (body: unknown, more: Record<string, unknown> = {}) => JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1,
  tool: 'x6_github', method: 'POST', pathname: '/_host/github', body, ...more })
const issue = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 'T', body: 'B' } }
const comment = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues/42/comments', body: { body: 'C' } }

describe('the staged outward request', () => {
  it('offers an issue or a comment on this repository, and says which', () => {
    expect(outwardWords(parseStagedOutward(file(issue))!).summary).toBe('GitHub: a new issue in your_org_x/your-node')
    expect(outwardWords(parseStagedOutward(file(comment))!).summary).toBe('GitHub: a comment on issue #42 in your_org_x/your-node')
  })

  it('offers nothing whose words would not match what the request does', () => {
    for (const body of [
      { ...issue, action: 'status' },
      { ...issue, method: 'GET' },
      { ...issue, method: undefined },
      { ...issue, extra: 1 },
      { ...issue, endpoint: 'repos/your_org_x/your-node/pulls' },
      { ...issue, endpoint: 'repos/other/repo/issues' },
      { ...issue, body: { title: 'T', body: 'B', labels: ['x'] } },
      { ...issue, body: { title: 'T\nsecond line', body: 'B' } },
      { ...issue, body: { title: '', body: 'B' } },
      { ...comment, body: { body: 'C', title: 'T' } },
      { ...comment, body: { body: '   ' } },
    ]) expect(parseStagedOutward(file(JSON.parse(JSON.stringify(body)))), JSON.stringify(body)).toBeNull()
    expect(parseStagedOutward(file(issue, { pathname: '/_host/repo' }))).toBeNull()
    expect(parseStagedOutward(file(issue, { tool: 'x6_repo' }))).toBeNull()
  })

  it('a repo write, edit or commit shows every field that leaves: content, old and new text, each file, base and key', () => {
    const repo = (body: Record<string, unknown>) => parseStagedOutward(file(body, { tool: 'x6_repo', pathname: '/_host/repo' }))!
    const base = { expectedHeadSha: 'a'.repeat(40), idempotencyKey: 'key-0123456789abcdef', message: 'Lane B3: one line' }
    const write = { ...base, action: 'write', path: 'docs/a.md', content: 'line one\nline two\n' }
    const edit = { ...base, action: 'edit', path: 'docs/b.md', oldString: 'old words', newString: 'new words', dryRun: false }
    const commit = { ...base, action: 'commit', changes: [{ path: 'x/1.ts', content: 'export const one = 1\n' }, { path: 'x/2.ts', content: '' }] }
    // Every leaf value of the body, as text, is the whole value of some row.
    const leaves = (value: unknown): string[] => (value !== null && typeof value === 'object'
      ? Object.values(value as Record<string, unknown>).flatMap(leaves) : [typeof value === 'string' ? value : JSON.stringify(value)])
    for (const body of [write, edit, commit]) {
      const words = outwardWords(repo(body))
      const values = words.rows.map(([, value]) => value)
      for (const leaf of leaves(body)) if (!['write', 'edit', 'commit'].includes(leaf)) expect(values.join('\u0000'), leaf).toContain(leaf)
      // Row names are unique (both cards key rows by name), and the request row still counts the bytes.
      expect(new Set(words.rows.map(([name]) => name)).size).toBe(words.rows.length)
      expect(words.rows.at(-1)?.[0]).toBe('request')
    }
    expect(outwardWords(repo(write)).rows).toContainEqual(['content', 'line one\nline two\n'])
    expect(outwardWords(repo(edit)).rows).toEqual(expect.arrayContaining([['oldString', 'old words'], ['newString', 'new words'], ['dryRun', 'false']]))
    expect(outwardWords(repo(commit)).rows).toEqual(expect.arrayContaining([['file 1 (x/1.ts) content', 'export const one = 1\n'],
      ['file 2 (x/2.ts) content', ''], ['expectedHeadSha', 'a'.repeat(40)], ['idempotencyKey', 'key-0123456789abcdef']]))
  })

  // The card prints a staged Cloudflare write in the key order of the bytes the edge sends and the
  // approval covers (canonicalJson), never through JSON.parse of the canonical text (that puts "2" and "10" first).
  it('a staged Cloudflare write reads the same whatever order her keys were in: the canonical order, "10" before "2"', () => {
    const cloudflare = (body: Record<string, unknown>) => parseStagedOutward(file(body, { tool: 'x6_cloudflare', pathname: '/_host/cloudflare',
      protection: { family: 'P1', reason: 'live-zone' } }))!
    const first = { action: 'api', method: 'PATCH', path: '/zones/abc/settings/ssl', query: { per_page: 5, '10': 'x', '2': 'y', a: 1 },
      body: { value: 'full', '10': { b: 1, a: [2, { d: 1, c: 0 }] }, '2': true, meta: { z: null, y: 'q' } } }
    const second = { body: { meta: { y: 'q', z: null }, '2': true, '10': { a: [2, { c: 0, d: 1 }], b: 1 }, value: 'full' },
      query: { a: 1, '2': 'y', '10': 'x', per_page: 5 }, path: '/zones/abc/settings/ssl', method: 'PATCH', action: 'api' }
    const [one, two] = [outwardWords(cloudflare(first)), outwardWords(cloudflare(second))]
    expect(one.rows).toEqual(two.rows)
    const rows = new Map(one.rows)
    // With the layout's whitespace removed, the body and query rows are exactly the canonical text the edge sends.
    expect(rows.get('body')!.replace(/\s+/gu, '')).toBe(canonicalJson(first.body))
    expect(rows.get('query')!.replace(/\s+/gu, '')).toBe(canonicalJson(first.query))
    expect(canonicalJson(first.body).indexOf('"10"')).toBeLessThan(canonicalJson(first.body).indexOf('"2"'))
    // Not the order JSON.parse would give back (integer-like keys first, in number order).
    expect(rows.get('body')!.replace(/\s+/gu, '')).not.toBe(JSON.stringify(JSON.parse(canonicalJson(first.body))))
    // A json part of a multipart body is printed the same way.
    const part = (json: Record<string, unknown>) => outwardWords(cloudflare({ action: 'api', method: 'PUT', path: '/accounts/{account}/workers/scripts/your-node',
      bodyKind: 'multipart', parts: [{ name: 'metadata', contentType: 'application/json', json }] })).rows
    expect(part({ main_module: 'w.js', '10': 1, '2': 2 })).toEqual(part({ '2': 2, '10': 1, main_module: 'w.js' }))
    expect(new Map(part({ main_module: 'w.js', '10': 1, '2': 2 })).get('part 1 (metadata) content')!.replace(/\s+/gu, ''))
      .toBe(canonicalJson({ main_module: 'w.js', '10': 1, '2': 2 }))
  })
})
