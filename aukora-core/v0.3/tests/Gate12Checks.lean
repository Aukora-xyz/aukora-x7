import Ratchet11

open Aukora Lean

private def readPart (name : String) := IO.FS.readBinFile ("v0.3/.work/package/" ++ name)

private def checkBool (label : String) (got expected : Bool) : IO Unit := do
  unless got == expected do throw (IO.userError s!"{label}: got {got}, expected {expected}")

def main : IO Unit := do
  let env ← readPart "laws.env"
  let some ctx := RatchetChecker.init env | throw (IO.userError "cannot load pinned R12 environment")
  let root ← readPart "root.law"
  let mut cases := [("same",RatchetChecker.rootNames,false,true),
    ("strong",RatchetChecker.rootNames ++ ["standard-genesis"],false,true),
    ("supplement",RatchetChecker.supplementNames,true,false)]
  for label in RatchetChecker.supplementNames.dropLast do
    cases := cases ++ [("drop-" ++ label,RatchetChecker.rootNames.erase label,false,false)]
  for (label,names,own,transition) in cases do
    let model ← readPart (label ++ ".model")
    let proof ← readPart (label ++ ".proof.expr")
    let some term := (RatchetChecker.spec model).bind RatchetChecker.expression
      | throw (IO.userError (label ++ " model predicate"))
    checkBool (label ++ " named set") (RatchetChecker.manifest term == some names) true
    let some g := RatchetChecker.goals ctx root model proof | throw (IO.userError (label ++ " goals"))
    if label == "same" then
      let ty := mkConst `Aukora.Release.Model
      let oldGoal := Expr.forallE `m ty (.forallE `h (.app term (.bvar 0)) (.app term (.bvar 1)) .default) .default
      let oldProof := Expr.lam `m ty (.lam `h (.app term (.bvar 0)) (.bvar 0) .default) .default
      checkBool "old self-implication: actual proof" (RatchetChecker.verifies g.env oldGoal oldProof) true
      checkBool "old self-implication: missing grammar commitment" (RatchetChecker.verifies g.env g.entails oldProof) false
      let localLaw := mkConst `R9Candidate.claimedLaw
      checkBool "candidate predicate is present inside package" (g.env.find? `R9Candidate.claimedLaw).isSome true
      checkBool "persistent law cannot reference a candidate-local predicate" (RatchetChecker.foundationOnly ctx.env localLaw) false
      IO.println "old self-implication verified alone; refused at combined grammar target; candidate-local law name excluded"
    if label.startsWith "drop-" then
      let selfGoal := RatchetChecker.entailmentGoal term term (mkConst `R9Candidate.successor)
      checkBool (label ++ " authentic self-transition including grammar") (RatchetChecker.verifies g.env selfGoal g.cert.entails) true
    let seenOwn := RatchetChecker.verifies g.env g.own g.cert.own
    let seenTransition := RatchetChecker.verifies g.env g.entails g.cert.entails
    checkBool (label ++ " satisfaction") seenOwn own
    checkBool (label ++ " transition (laws and grammar)") seenTransition transition
    let reason := Ratchet11.packageReason ctx none model proof
    unless reason == (if transition then 7 else 8) do throw (IO.userError s!"{label}: reason {reason}")
    IO.println s!"{label}: {names.length} clauses; satisfaction={seenOwn}; transition={seenTransition}; refused={reason}"
