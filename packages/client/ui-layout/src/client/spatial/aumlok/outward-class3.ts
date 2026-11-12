// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * AUMA'S OUTWARD CLASS 3 REQUESTS, APPROVED BY TOUCH ID ON THE EXACT BYTES.
 *
 * When the edge will not post Auma's GitHub issue or comment without the owner's passkey, her worker stages the exact
 * request at `STAGED_OUTWARD_PATH` (`ball-loader.ts` `stageOutward`). This page:
 *
 *   1. reads it strictly: one POST to `/_host/github`, with a JSON body, nothing else;
 *   2. shows the owner what those bytes do, in words, with the full text;
 *   3. at his click reads the file again, and asks only if it is still the same request;
 *   4. binds exactly that request (`class3Action`), asks the passkey for it (`approveClass3`), and sends it
 *      (`sendApprovedClass3`), so the host checks the same path, method and body hash it approved.
 *
 * A GitHub post has no idempotency key, so a request this page has sent is remembered and not offered again.
 * @module aumlok/outward-class3
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkReader } from '../work/WorkSurface.tsx'
import { approveClass3, canonicalJson, class3Action, sendApprovedClass3, type Class3Dependencies, type Class3Sent } from './class3-approval.ts'

export const STAGED_OUTWARD_PATH = '/dsh/home/auma/staged/outward-class3.json'
export const STAGED_OUTWARD_SCHEMA = 'aukora.staged-outward-class3.v1'
export const STAGED_OUTWARD_MAX_BYTES = 256 * 1024
/** A live change to the staged file (`changedPaths` name it with or without the `/dsh` root). */
export const STAGED_OUTWARD_CHANGE = /(?:^|\/)home\/auma\/staged\/outward-class3\.json$/u

const REPOSITORY = 'repos/your_org_x/your-node'
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** One staged request, as read. */
export interface StagedOutward {
  readonly tool: 'x6_github' | 'x6_repo'
  readonly pathname: '/_host/github' | '/_host/repo'
  readonly method: 'POST'
  readonly body: Record<string, unknown>
  readonly stagedAt: number
  /** The canonical body: the same text the host hashes. Two reads are the same request when this matches. */
  readonly canonical: string
}

const ISSUE_POST = /^\/?repos\/your_org_x\/your-node\/issues(?:\/([1-9][0-9]{0,8})\/comments)?$/u
const said = (value: unknown, max: number): boolean => typeof value === 'string' && value.trim() !== '' && value.length <= max
/**
 * Only the one request this card describes: `x6_github` `api` POST opening an issue (`{ title, body }`) or commenting on
 * one (`{ body }`) in this repository, nothing else in it. Anything else is not offered, so the words the owner reads are
 * always what the request does.
 */
function postable(body: Record<string, unknown>): boolean {
  if (Object.keys(body).some(key => !['action', 'method', 'endpoint', 'body'].includes(key))) return false
  if (body.action !== 'api' || body.method !== 'POST' || typeof body.endpoint !== 'string' || !record(body.body)) return false
  const match = body.endpoint.match(ISSUE_POST)
  if (match === null) return false
  const post = body.body
  if (match[1] !== undefined) return Object.keys(post).length === 1 && said(post.body, 65_536)
  return Object.keys(post).every(key => key === 'title' || key === 'body') && said(post.title, 256) && !/[\r\n]/u.test(String(post.title))
    && said(post.body, 65_536)
}

function repoPostable(body: Record<string, unknown>): boolean {
  if (!['write', 'edit', 'commit'].includes(String(body.action ?? ''))) return false
  if (typeof body.path === 'string' && body.path.trim() !== '') return true
  if (Array.isArray(body.changes) && body.changes.length > 0 && body.changes.every(c => record(c) && typeof c.path === 'string')) return true
  return false
}

/**
 * Read a staged file strictly.
 * @param text - the file's text.
 * @returns the request, or null when it is anything else.
 */
export function parseStagedOutward(text: string): StagedOutward | null {
  if (new TextEncoder().encode(text).byteLength > STAGED_OUTWARD_MAX_BYTES) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!record(value) || Object.keys(value).some(key => !['schema', 'stagedAt', 'tool', 'method', 'pathname', 'body'].includes(key))) return null
  if (value.schema !== STAGED_OUTWARD_SCHEMA || value.method !== 'POST' || !record(value.body)
    || !Number.isSafeInteger(value.stagedAt) || (value.stagedAt as number) < 0) return null
  if (value.tool === 'x6_repo' && value.pathname === '/_host/repo' && repoPostable(value.body)) {
    return { tool: 'x6_repo', pathname: '/_host/repo', method: 'POST',
      body: value.body, stagedAt: value.stagedAt as number, canonical: canonicalJson(value.body) }
  }
  if (value.tool !== 'x6_github' || value.pathname !== '/_host/github' || !postable(value.body)) return null
  return { tool: 'x6_github', pathname: '/_host/github', method: 'POST',
    body: value.body, stagedAt: value.stagedAt as number, canonical: canonicalJson(value.body) }
}

/** Her staged file, as one window read it. */
export type StagedOutwardRead =
  /** Nothing staged, or her home was not read: nothing is offered. */
  | { readonly kind: 'none' }
  /** A file is there, but it is not a request this page can read. */
  | { readonly kind: 'malformed' }
  | { readonly kind: 'staged'; readonly staged: StagedOutward }

/**
 * Read her staged request from this window's copy of her home. Every card that offers it reads it this one way.
 * @param reader - the page's reader of her files.
 * @param sessionId - the Session whose home is read (undefined: none is open, so nothing is read).
 * @param signal - aborts the read.
 * @returns the request, `malformed`, or `none` (a file that is not there, or a read that failed).
 */
export async function readStagedOutward(reader: WorkReader, sessionId: SessionId | undefined, signal: AbortSignal)
  : Promise<StagedOutwardRead> {
  if (sessionId === undefined) return { kind: 'none' }
  const file = await reader.whole(sessionId, STAGED_OUTWARD_PATH, signal).catch(() => null)
  if (file === null || !file.ok) return { kind: 'none' }
  const staged = parseStagedOutward(file.text)
  return staged === null ? { kind: 'malformed' } : { kind: 'staged', staged }
}

/** What the owner reads before he approves: a one-line summary and the rows of exactly what goes out. */
export interface OutwardWords {
  readonly summary: string
  readonly rows: readonly (readonly [string, string])[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value) ?? '')
const bytes = (value: unknown): number => new TextEncoder().encode(text(value)).byteLength

/**
 * Say what a staged request does.
 * @param staged - the request.
 * @returns its summary and rows (every byte that leaves is shown or counted).
 */
export function outwardWords(staged: StagedOutward): OutwardWords {
  const body = staged.body
  if (staged.tool === 'x6_repo') {
    const action = text(body.action)
    const targetPath = typeof body.path === 'string'
      ? body.path
      : Array.isArray(body.changes)
        ? body.changes.map(c => (record(c) && typeof c.path === 'string' ? c.path : '')).filter(Boolean).join(', ')
        : 'repository'
    // EVERY FIELD THAT LEAVES IS A ROW: the file content of a write, the old and new text of an edit, each file of a commit,
    // and every other field the request carries (base sha, idempotency key, dry run), so Touch ID never approves a byte
    // the card did not show.
    const changes = Array.isArray(body.changes) ? body.changes : []
    const changeRows = changes.flatMap((change, index): (readonly [string, string])[] => {
      const file = record(change) ? change : {}
      const label = `file ${String(index + 1)} (${text(file.path)})`
      return Object.keys(file).sort().filter(key => key !== 'path').map(key => [`${label} ${key}`, text(file[key])] as const)
    })
    const named = new Set(['action', 'path', 'message', 'changes'])
    const rest = Object.keys(body).sort().filter(key => !named.has(key)).map(key => [key, text(body[key])] as const)
    return {
      summary: `T2 Gate: ${action} ${targetPath} in your_org_x/your-node`,
      rows: [
        ['action', `${action} (${targetPath})`],
        ...(typeof body.message === 'string' ? [['message', body.message] as const] : []),
        ...rest,
        ...changeRows,
        ['request', `POST /_host/repo · ${String(bytes(staged.canonical))} bytes`],
      ],
    }
  }
  const endpoint = text(body.endpoint).replace(/^\/+/u, '')
  const post = record(body.body) ? body.body : {}
  const comment = endpoint.match(/^repos\/your_org_x\/your-node\/issues\/(\d+)\/comments$/u)
  const where = comment !== null ? `a comment on issue #${comment[1] ?? ''}` : endpoint === `${REPOSITORY}/issues` ? 'a new issue' : `POST ${endpoint}`
  return {
    summary: `GitHub: ${where} in your_org_x/your-node`,
    rows: [
      ['posts', where],
      ...(typeof post.title === 'string' ? [['title', post.title] as const] : []),
      ['text', text(post.body)],
      ['request', `POST /_host/github · ${String(bytes(staged.canonical))} bytes`],
    ],
  }
}

/**
 * The outcome of one approval: what to tell the owner. `refused` only when the host's own answer proves nothing went out (a
 * parsed refusal code given before it posted); any other failure after the approval is `unknown`: it may have gone out.
 */
export type OutwardOutcome =
  | { readonly kind: 'sent'; readonly words: string; readonly sent: Class3Sent }
  | { readonly kind: 'refused'; readonly words: string; readonly sent: Class3Sent | null }
  | { readonly kind: 'unknown'; readonly words: string; readonly sent: Class3Sent | null }

const MAYBE_SENT = 'It may have gone out: check GitHub before approving it again.'

/**
 * Approve one staged request with the passkey and send exactly it.
 * @param staged - the request as read at the click.
 * @param origin - this page's origin (the audience the host binds).
 * @param deps - the passkey and host call (tests pass their own), and the abort signal.
 * @param fetchImpl - the page's fetch.
 * @returns what happened.
 */
export async function approveAndSendOutward(staged: StagedOutward, origin: string, deps: Class3Dependencies,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<OutwardOutcome> {
  const action = await class3Action({ audience: origin, method: staged.method, pathname: staged.pathname, body: staged.body })
  const approval = await approveClass3(action, deps)
  if (!approval.ok) return { kind: 'refused', words: `Not sent: the passkey approval did not complete (${approval.reason}).`, sent: null }
  let sent: Class3Sent
  try {
    sent = await sendApprovedClass3(approval, staged.body, deps.signal, fetchImpl)
  } catch (error) {
    return { kind: 'unknown', words: `No answer came back (${error instanceof Error ? error.message : String(error)}). ${MAYBE_SENT}`, sent: null }
  }
  const answer = sent.body
  if (sent.status === 200 && answer?.ok === true) {
    const json = record(answer.json) ? answer.json : null
    const link = json !== null && typeof json.url === 'string' ? ` ${json.url}` : ''
    return { kind: 'sent', words: `Sent.${link}`, sent }
  }
  // The broker names every refusal it gives before posting with a code; an answer that is not one (no JSON, no code, or
  // its own "outcome unknown") does not prove the post did not happen.
  if (answer !== null && typeof answer.code === 'string' && answer.outcome !== 'unknown' && sent.status >= 400 && sent.status < 600) {
    return { kind: 'refused', words: `Not sent: the host refused it (${answer.code}).`, sent }
  }
  const code = typeof answer?.code === 'string' ? answer.code : `HTTP ${String(sent.status)}`
  return { kind: 'unknown', words: `The host answered ${code}. ${MAYBE_SENT}`, sent }
}
