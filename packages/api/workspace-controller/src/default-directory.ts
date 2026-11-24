/** Resolve the Host account's Documents directory for first-use Workspace creation. */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { DEFAULT_WORKSPACE_DIRECTORY } from './default-workspace.ts'

/** Platform observations replaceable in directory-resolution tests. */
interface DocumentsDirectoryInternals {
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly run?: NativeCommandRunner
  /** Whether this Host is the browser WebWorker (tests set it; otherwise read from `process.title`). */
  readonly worker?: boolean
}

/** The process title the browser WebWorker runtime reports (`webworker-runtime` `node/globals/process.ts`). */
export const WEBWORKER_PROCESS_TITLE = 'dsh-webworker'
/**
 * AUMA IS THE META-WORKSPACE (North Star §24.2): in the browser WebWorker the one root workspace is her own home,
 * `<home>/auma` (`/dsh/home/auma`), titled `auma`. Sub-workspaces live under `<home>/auma/workspaces/<name>`.
 */
export const WORKER_ROOT_WORKSPACE = 'auma'

/**
 * Validate a configured or OS-returned Documents path without resolving it against cwd.
 * @param directory - fully qualified directory spelling.
 * @param platform - Host platform.
 * @returns the normalized directory.
 */
export function validateDocumentsDirectory(directory: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? win32 : posix
  const root = paths.parse(directory).root
  if (!paths.isAbsolute(directory) || (platform === 'win32' && (root === '\\' || root === '/'))) {
    throw new Error(`Documents directory must be fully qualified: '${directory}'`)
  }
  return paths.normalize(directory)
}

/**
 * Resolve the first-use directory on the Host without creating files.
 * @param documentsDirectory - explicit deployment override for the system Documents directory.
 * @param signal - caller lifetime and lookup deadline.
 * @param internals - platform facts and native command runner.
 * @returns the absolute candidate path.
 */
export async function defaultWorkspaceDirectory(
  documentsDirectory: string | undefined,
  signal: AbortSignal,
  internals: DocumentsDirectoryInternals = {},
): Promise<string> {
  const platform = internals.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  signal.throwIfAborted()
  // NO NATIVE COMMAND EVER RUNS IN A BROWSER WORKER. The worker reports itself as linux, so without this the lookup below
  // would try `xdg-user-dir`, which no worker can run. There the first-use workspace is her home itself.
  const worker = internals.worker ?? (typeof process.title === 'string' && process.title === WEBWORKER_PROCESS_TITLE)
  if (worker && documentsDirectory === undefined) return posix.join(internals.home ?? homedir(), WORKER_ROOT_WORKSPACE)
  let directory = documentsDirectory
  if (directory === undefined) {
    const run = internals.run ?? runNativeCommand
    let stdout: string
    switch (platform) {
      case 'darwin':
        ({ stdout } = await run('osascript', [
          '-e', 'POSIX path of (path to documents folder from user domain without folder creation)',
        ], signal, 'hidden'))
        break
      case 'win32':
        ({ stdout } = await run('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
          + '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, '
          + '[Environment+SpecialFolderOption]::DoNotVerify)',
        ], signal, 'hidden'))
        break
      case 'linux':
        ({ stdout } = await run('xdg-user-dir', ['DOCUMENTS'], signal, 'hidden'))
        break
      default:
        throw new Error(`system Documents directory is unavailable on ${platform}`)
    }
    directory = stdout.replace(/[\r\n]+$/, '')
    // XDG reports the home directory when this user directory is disabled.
    if (directory === '' || (platform === 'linux' && paths.normalize(directory) === (internals.home ?? homedir()))) {
      throw new Error('system Documents directory is unavailable')
    }
  }
  directory = validateDocumentsDirectory(directory, platform)
  signal.throwIfAborted()
  return paths.join(directory, 'deepseek-harness', DEFAULT_WORKSPACE_DIRECTORY)
}
