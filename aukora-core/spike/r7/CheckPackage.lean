import KernelCell

open R6.KernelCell
open private exprField exactly from KernelCell

private def diagnose (ctx : Context) (bytes : ByteArray) : IO String := do
  let some p := exactly exprField bytes | return "R6 decoder rejected the submitted expression"
  match Lean4Lean.TypeChecker.M.run ctx.env (x := Lean4Lean.TypeChecker.check p []) with
  | .error e => return "type inference: " ++ (← (e.toMessageData {}).toString)
  | .ok inferred =>
    match Lean4Lean.TypeChecker.M.run ctx.env (x := Lean4Lean.TypeChecker.isDefEq inferred ctx.goal) with
    | .error e => return "goal comparison: " ++ (← (e.toMessageData {}).toString)
    | .ok equal => return s!"inferred {inferred.getAppFn}; expected {ctx.goal.getAppFn}; definitionally equal={equal}"

def main : IO Unit := do
  let env ← IO.FS.readBinFile "logs/r7/laws.env"
  let labels := ["logs/r7/model", "logs/r7/other", "logs/r6/wrong_digest"]
  for goalLabel in labels do
    let goal ← IO.FS.readBinFile (goalLabel ++ ".type.expr")
    let some ctx := init env goal | throw <| IO.userError s!"could not load {goalLabel}"
    for proofLabel in labels do
      let proof ← IO.FS.readBinFile (proofLabel ++ ".proof.expr")
      let actual := check ctx proof
      IO.println s!"native lean4lean goal={goalLabel} proof={proofLabel}: {actual}"
      unless actual == (proofLabel == goalLabel) do
        throw <| IO.userError s!"unexpected verdict for goal {goalLabel}, proof {proofLabel}: {← diagnose ctx proof}"
