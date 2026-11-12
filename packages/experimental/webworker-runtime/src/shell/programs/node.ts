/** Aukora X5: `node` shell program; executes in the host worker (see process/node-runner.ts). */
import type { ShellProgram } from '../types.ts'
import { runNodeCommand } from '../process/node-runner.ts'

export const node: ShellProgram = async (argv, io, state, fs) => {
  // A process worker RPCs to the host (fs.node); inline runs are already in the host.
  const run = fs.node === undefined ? runNodeCommand : fs.node.bind(fs)
  const result = await run(argv.slice(1), state.cwd, io.stdin)
  io.out(result.stdout)
  io.err(result.stderr)
  return result.exitCode
}
