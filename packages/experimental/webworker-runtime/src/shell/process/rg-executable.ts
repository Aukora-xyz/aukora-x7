/** Aukora X5: `/dsh/bin/rg` (the `@vscode/ripgrep` stub path) delegates to the shell's `rg` program. */
import type { VirtualExecutable } from './virtual-executables.ts'

export const RG_EXECUTABLE: VirtualExecutable = {
  name: 'rg',
  async prepare(args, context) {
    return {
      kind: 'delegate',
      argv: ['rg', ...args],
      filesystem: context.filesystem,
      missingExecutable: { kind: 'exit', exitCode: 127, stdout: '', stderr: 'rg: not available\n' },
    }
  },
  runSync() {
    return { kind: 'asynchronous' }
  },
}
