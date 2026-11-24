import Ratchet11

open Aukora Lean

private def part (name : String) := IO.FS.readBinFile ("v0.4/.work/package/" ++ name)

def main (args : List String) : IO Unit := do
  let some ctx := RatchetChecker.init (← part "laws.env") | throw (IO.userError "invalid foundation")
  let root ← part "root.law"
  let strong ← part "strong.law"
  let labels := if args.isEmpty then ["same","strong","strong-next","wrong-own","supplement"] ++
    (RatchetChecker.rootNames.map ("drop-" ++ ·)) else args
  for label in labels do
    let model ← part (label ++ ".model")
    let proof ← part (label ++ ".proof.expr")
    let some child := RatchetChecker.spec model | throw (IO.userError s!"{label}: malformed set")
    let some names := (RatchetChecker.expression child).bind RatchetChecker.manifest
      | throw (IO.userError s!"{label}: no manifest")
    let dropped := label.startsWith "drop-"
    let expectedNames := if dropped then RatchetChecker.rootNames.erase (label.drop 5)
      else if label.startsWith "strong" then RatchetChecker.rootNames ++ ["standard-genesis"]
      else if label == "supplement" then RatchetChecker.supplementNames else RatchetChecker.rootNames
    unless names == expectedNames do throw (IO.userError s!"{label}: unexpected names")
    let parent := if label == "strong-next" then strong else root
    let some g := RatchetChecker.goals ctx parent model proof | throw (IO.userError s!"{label}: no goals")
    let own := RatchetChecker.verifies g.env g.own g.cert.own
    let edge := RatchetChecker.verifies g.env g.entails g.cert.entails
    let retained := RatchetChecker.retainsNames parent child
    let goodEdge := !dropped && label != "supplement"
    let goodOwn := label != "wrong-own"
    unless (own == goodOwn && edge == goodEdge && retained == goodEdge) do
      throw (IO.userError s!"{label}: own={own}, transition={edge}, names retained={retained}")
    if goodEdge && goodOwn then
      unless Checker9.check ctx model proof do throw (IO.userError s!"{label}: final install check failed")
      if Checker9.frozenCheck ctx model proof then throw (IO.userError s!"{label}: unexpected frozen L8 acceptance")
    IO.println s!"{label}: {names.length} named clauses, own={own}, transition={edge}, names retained={retained}"
