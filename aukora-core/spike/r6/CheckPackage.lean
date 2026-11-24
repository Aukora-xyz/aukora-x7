import KernelCell
open R6.KernelCell
def main : IO Unit := do
  let env ← IO.FS.readBinFile "logs/r6/wrong_digest.env"
  let goal ← IO.FS.readBinFile "logs/r6/wrong_digest.type.expr"
  let proof ← IO.FS.readBinFile "logs/r6/wrong_digest.proof.expr"
  let some ctx := init env goal | throw (IO.userError "native adapter rejected environment or goal")
  if !check ctx proof then throw (IO.userError "native adapter rejected original stored proof")
  if check ctx ⟨#[1, 0]⟩ then throw (IO.userError "native adapter accepted Sort 0")
  IO.println "native adapter: pinned environment and goal accepted; stored R5 proof accepted; Sort 0 refused"
