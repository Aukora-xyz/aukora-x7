/** Restricted local-host model tools. These checks are not an operating-system sandbox. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Version of the model-visible source and metadata read policy. */
export const MODEL_HOST_POLICY = 'read-only-source-v1'
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code, status: 403 }) }
const sourceExtensions = /\.(?:[cm]?[jt]s|tsx|jsx|css|html|vue|svelte)$/
const privatePart = /(?:^|[._-])(?:private|secrets?|credentials?|passwords?|tokens?|env|vault)(?:[._-]|$)/i
const blockedParts = new Set(['node_modules', 'dist', 'lib', 'mirror', 'generated', 'coverage', 'sessions', 'storages', 'tmp', 'temp', 'backups', 'memory-history'])

function requestObject(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) fail('MODEL_HOST_REQUEST_REFUSED')
}

/** Return a canonical source-relative path; metadata, credentials and generated files are excluded.
 * @param {unknown} input Untrusted model path.
 * @returns {string} A permitted source path, without interpreting escapes or glob syntax.
 */
export function assertModelSourcePath(input) {
  if (typeof input !== 'string' || input.length > 1024 || !/^[A-Za-z0-9_./-]+$/.test(input) || path.posix.normalize(input) !== input) fail('MODEL_SOURCE_PATH_REFUSED')
  const parts = input.split('/')
  if (parts.some(part => !part || part.startsWith('.') || blockedParts.has(part.toLowerCase()) || privatePart.test(part))) fail('MODEL_SOURCE_PATH_REFUSED')
  if (['README.md', 'AGENTS.md', 'LICENSE'].includes(input)) return input
  if (/^docs\/.+\.md$/.test(input)) return input
  if (/^(?:server\/|deploy\/cloudflare\/src\/|apps\/[^/]+\/src\/|packages\/[^/]+\/[^/]+\/src\/)/.test(input) && sourceExtensions.test(input)) return input
  fail('MODEL_SOURCE_PATH_REFUSED')
}

/** Decide a repo action without spawning commands or reading files.
 * @param {unknown} body Untrusted request body.
 * @returns {object} A fixed source or metadata read; subprocesses and mutations fail closed.
 */
export function planModelRepoAction(body) {
  requestObject(body, ['action', 'path', 'command', 'content', 'paths', 'message'])
  if (body.action === 'write' || body.action === 'commit') fail('MODEL_REPO_MUTATION_DISABLED', 'Repository writes and commits require an owner-operated workflow outside model host tools.')
  if (body.action === 'read') {
    requestObject(body, ['action', 'path'])
    const sourcePath = assertModelSourcePath(body.path)
    return { kind: 'read', path: sourcePath }
  }
  if (body.action === 'status') {
    requestObject(body, ['action'])
    return { kind: 'status' }
  }
  if (body.action === 'exec') {
    requestObject(body, ['action', 'command'])
    const command = new Map([
      ['git status', 'status'],
      ['git status --short -b', 'status'],
      ['git rev-parse --short=8 HEAD', 'head'],
    ]).get(body.command)
    if (!command) fail('MODEL_EXEC_DISABLED', 'Only fixed read-only repository observations are available; shell commands are disabled.')
    return { kind: command }
  }
  fail('MODEL_REPO_ACTION_REFUSED')
}

/** Return an honest policy-status operation, never an ambient-credential CLI or API request.
 * @param {string} surface Either github or cloudflare.
 * @param {unknown} body Untrusted request body.
 * @returns {object} A status descriptor; all executable integration actions are disabled.
 */
export function planModelIntegrationAction(surface, body) {
  if (!['github', 'cloudflare'].includes(surface)) fail('MODEL_INTEGRATION_REFUSED')
  requestObject(body, ['action'])
  if (body.action !== undefined && body.action !== 'status') fail('MODEL_INTEGRATION_DISABLED', 'Host credential CLI and API access is disabled for model tools.')
  return { kind: 'status', surface }
}

async function inspectSource(repository, relative, maxBytes) {
  const root = path.resolve(repository)
  if (!path.isAbsolute(repository) || repository !== root || await fsp.realpath(root) !== root) fail('MODEL_SOURCE_LINK_REFUSED')
  const rootStat = await fsp.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('MODEL_SOURCE_LINK_REFUSED')
  const parts = relative.split('/')
  let target = root
  let stat
  for (let index = 0; index < parts.length; index += 1) {
    target = path.join(target, parts[index])
    stat = await fsp.lstat(target)
    if (stat.isSymbolicLink()) fail('MODEL_SOURCE_LINK_REFUSED')
    if (index < parts.length - 1 && !stat.isDirectory()) fail('MODEL_SOURCE_FILE_REQUIRED')
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || await fsp.realpath(target) !== target) fail('MODEL_SOURCE_FILE_REQUIRED')
  return { target, stat }
}

// Callers supply either an allowlisted source path or a fixed, validated Git metadata path.
async function readBoundedText(repository, relative, maxBytes) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW) || !Number.isInteger(fs.constants.O_NONBLOCK)) fail('MODEL_SOURCE_NOFOLLOW_UNAVAILABLE')
  const before = await inspectSource(repository, relative, maxBytes)
  const handle = await fsp.open(before.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.stat.dev || opened.ino !== before.stat.ino || opened.size > maxBytes) fail('MODEL_SOURCE_CHANGED')
    // Fixed-size reads also bound a file that grows after the initial stat.
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await inspectSource(repository, relative, maxBytes)
    const finalStat = await handle.stat()
    if (length > maxBytes || length !== opened.size || finalStat.size !== opened.size || finalStat.mtimeMs !== opened.mtimeMs || finalStat.ctimeMs !== opened.ctimeMs || after.stat.dev !== opened.dev || after.stat.ino !== opened.ino) fail('MODEL_SOURCE_CHANGED')
    let content
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) } catch { fail('MODEL_SOURCE_TEXT_REQUIRED') }
    if (content.includes('\0') || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(content) || /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(content)) fail('MODEL_SOURCE_PRIVATE_DATA_REFUSED')
    return content
  } finally { await handle.close() }
}

/** Read bounded UTF-8 source without following symlinks, hardlinks, or changing paths.
 * @param {string} repository Absolute repository root.
 * @param {unknown} input Untrusted relative source path.
 * @returns {Promise<string>} Permitted source text only.
 */
export async function readModelSourceFile(repository, input) {
  return readBoundedText(repository, assertModelSourcePath(input), MAX_SOURCE_BYTES)
}

/** Read only HEAD and its exact branch ref. Git configs, filters, hooks and index are never loaded.
 * @param {string} repository Absolute repository root; redirected worktrees are unsupported.
 * @returns {Promise<object>} Metadata with explicitly uninspected worktree changes, never a clean-tree claim.
 */
export async function readModelRepositoryStatus(repository) {
  const raw = await readBoundedText(repository, '.git/HEAD', 1024)
  const hashPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
  let branch = null
  let head = raw.trim()
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5)
    if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(ref) || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')) || ref.includes('..') || ref.endsWith('.')) fail('MODEL_REPOSITORY_METADATA_REFUSED')
    branch = ref.slice('refs/heads/'.length)
    try { head = (await readBoundedText(repository, `.git/${ref}`, 1024)).trim() } catch (error) {
      if (error.code !== 'ENOENT') throw error
      let packed = ''
      try { packed = await readBoundedText(repository, '.git/packed-refs', MAX_SOURCE_BYTES) } catch (packedError) {
        if (packedError.code !== 'ENOENT') throw packedError
      }
      const matches = packed.split('\n').filter(line => line.endsWith(` ${ref}`))
      if (matches.length > 1) fail('MODEL_REPOSITORY_METADATA_REFUSED')
      head = matches.length ? matches[0].slice(0, matches[0].indexOf(' ')) : null
    }
  }
  if (head !== null && !hashPattern.test(head)) fail('MODEL_REPOSITORY_METADATA_REFUSED')
  if (await readBoundedText(repository, '.git/HEAD', 1024) !== raw) fail('MODEL_SOURCE_CHANGED')
  return { policy: MODEL_HOST_POLICY, branch, head, worktreeStatus: 'not-inspected' }
}
