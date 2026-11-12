/** Scoped convenience commits. Privileged host exec is not confined by this guard. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, status: 409, ...details }) }
const rootFiles = new Set(['.gitignore', 'LICENSE', 'Makefile', 'AGENTS.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'README.md'])
const excludedParts = new Set(['mirror', 'private', 'generated', 'node_modules', 'dist', 'lib', 'sessions', 'storages', 'snapshots', 'coverage', 'tmp', 'temp', 'backups', 'memory-history'])
const aumaMirrorPath = file => (
  /^mirror\/home\/auma\/seed\/organs\/[a-z0-9-]+\.js$/.test(file)
  || /^mirror\/home\/auma\/seed\/(?:manifest\.json|receipts\.v3\.jsonl|checkpoints\.v1\.jsonl|discovery-corpus\.v1(?:\.unverified)?\.jsonl|ledger\.jsonl|scars\.jsonl|aura\.v1\.json|owner-key\.v1\.json|WISH\.md|CONTEXT(?:\.unverified)?\.md)$/.test(file)
  || /^mirror\/home\/auma\/seed\/(?:predict|aura|pearl)\/[a-z0-9._-]+\.(?:json|jsonl)$/.test(file)
  || /^mirror\/home\/organs\/[a-f0-9]{64}\.js$/.test(file)
  || /^mirror\/(?:home\/)?balls\/(?:HEAD\.json|manifest-[a-f0-9]{64}\.json|[a-f0-9]{64}\.(?:js|meta\.json)|history\/(?:\d+-)?[a-f0-9]{64}\.json)$/.test(file)
  || /^mirror\/home\/auma\/memory\/(?:dag\/)?(?:HEAD\.json|(?:nodes\/)?[a-f0-9]{64}\.json)$/.test(file)
  || /^mirror\/home\/auma\/snapshots\/(?:LATEST\.json|[a-f0-9]{64}\.json)$/.test(file)
  || /^mirror\/home\/auma\/(?:superagent\/state\.json|receipts\.jsonl)$/.test(file)
  || /^mirror\/home\/auma(?:-one)?\/[A-Za-z0-9._-]+\.md$/.test(file)
  || /^docs\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md$/.test(file)
  || /^reviews\/[A-Za-z0-9_.-]+\.md$/.test(file)
)
const sourcePath = file => {
  if (rootFiles.has(file) || aumaMirrorPath(file)) return true
  const parts = file.toLowerCase().split('/')
  if (parts.some(part => part.startsWith('.') || excludedParts.has(part) || /(?:^|[._-])(?:private|generated|secrets?|credentials?|passwords?|tokens?|env)(?:[._-]|$)/.test(part))) return false
  return (/^(?:server\/|deploy\/cloudflare\/src\/|apps\/[^/]+\/src\/|packages\/[^/]+\/[^/]+\/src\/)/.test(file)
    && /\.(?:[cm]?js|[cm]?ts|tsx|jsx|css|html|vue|svelte)$/.test(file))
    || /^packages\/[^/]+\/[^/]+\/README\.md$/.test(file)
}

/** Serialize bridge calls and never stage the whole checkout or consume an existing index. */
export function createSourceCommitter({ directory }) {
  let queue = Promise.resolve()
  const git = async args => (await run('git', ['--literal-pathspecs', ...args], { cwd: directory, maxBuffer: 4 * 1024 * 1024 })).stdout
  async function commit(body) {
    let stagedPaths = []
    try {
      if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 64) fail('SOURCE_PATHS_REQUIRED')
      const files = body.paths
      const rejected = files.find(file => typeof file !== 'string' || !file || file.length > 1024 || /[\\\0\r\n]/.test(file) || path.posix.normalize(file) !== file || !sourcePath(file))
      if (rejected !== undefined || new Set(files).size !== files.length) {
        fail('UNSAFE_SOURCE_PATH', { rejectedPath: typeof rejected === 'string' ? rejected.slice(0, 200) : null })
      }
      const message = body.message
      if (typeof message !== 'string' || !message.trim() || message.length > 1024 || message.includes('\0')) fail('COMMIT_MESSAGE_REQUIRED')
      if ((await git(['symbolic-ref', '--short', 'HEAD'])).trim() !== 'main') fail('MAIN_BRANCH_REQUIRED')
      if ((await git(['diff', '--cached', '--name-only', '-z'])).length) fail('EXISTING_STAGED_WORK_RETAINED')
      for (const file of files) {
        const target = path.join(directory, file)
        const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024 || await fs.realpath(target) !== target) fail('SOURCE_FILE_REQUIRED')
          const bytes = await fs.readFile(target)
          let text
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('SOURCE_TEXT_REQUIRED') }
          if (text.includes('\0') || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text) || /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text)) fail('POSSIBLE_PRIVATE_DATA_REFUSED')
        } else {
          if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) fail('SOURCE_FILE_REQUIRED')
          await git(['ls-files', '--error-unmatch', '--', file])
        }
      }
      if (!(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...files])).length) fail('NO_SOURCE_CHANGES')
      // --only excludes unrelated staging even if an external Git user races us.
      // Never reset/restore their index or worktree on failure; report own staging.
      stagedPaths = files
      await git(['add', '--', ...files])
      const staged = (await git(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
      if (staged.some(file => !files.includes(file))) fail('CONCURRENT_STAGED_WORK_RETAINED')
      // Formatting hooks may rewrite user files; checks belong before this
      // explicitly requested commit, never an implicit worktree mutation here.
      const stdout = await git(['-c', 'core.hooksPath=/dev/null', 'commit', '--only', '-m', message, '--', ...files])
      return { ok: true, commit: (await git(['rev-parse', 'HEAD'])).trim(), paths: files, stdout }
    } catch (error) {
      return { ok: false, status: error.status ?? 503, code: error.code ?? 'SOURCE_COMMIT_FAILED', error: error.message, ...(error.rejectedPath ? { rejectedPath: error.rejectedPath } : {}), stagedPaths, outcome: 'inspect-git-status-before-retrying' }
    }
  }
  return body => {
    const result = queue.then(() => commit(body))
    queue = result.then(() => undefined, () => undefined)
    return result
  }
}
