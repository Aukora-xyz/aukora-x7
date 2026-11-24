import Ark3One
import core.Bound5
import Lean.Elab.Command
import Lean4Lean.TypeChecker

open Lean
-- Check the unmodified stored proof in the native environment first. This exposes
-- rejections independent of the Wasm port. The shipped cell pins a smaller environment.
run_cmd
  let env ← getEnv
  for name in [``Aukora.Ark3.lastFour, ``Aukora.Bound5.wrong_digest, ``Aukora.Bound4.feed_chunks] do
    let .thmInfo t ← getConstInfo name | throwError "expected theorem"
    let check (p : Expr) := Lean4Lean.TypeChecker.M.run env.toKernelEnv (x := do
      let ty ← Lean4Lean.TypeChecker.check p []
      Lean4Lean.TypeChecker.isDefEq ty t.type)
    match check t.value, check (.sort .zero) with
    | .ok true, .ok false => logInfo m!"{name}: accepted original; rejected Sort 0"
    | .error e, _ => logInfo m!"{name}: original refused: {e.toMessageData {}}"
    | _, _ => throwError "unexpected control verdicts"
