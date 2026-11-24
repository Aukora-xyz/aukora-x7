import core.Checker9

open Lean Aukora.Checker9

private def expect (label : String) (b expected : Bool) : IO Unit := do
  IO.println s!"{label}: {b} (expected {expected})"
  unless b == expected do throw <| IO.userError s!"unexpected result for {label}"

private def constBytes (n : String) : List UInt8 :=
  let name := (n.splitOn ".").foldl (fun stem text =>
    1 :: (stem ++ [text.toUTF8.size.toUInt8] ++ text.toUTF8.data.toList)) [0]
  2 :: name ++ [0]

def main : IO Unit := do
  let some base := init (← IO.FS.readBinFile "logs/r7/laws.env") | throw <| IO.userError "environment"
  let honest ← IO.FS.readBinFile "logs/r9/honest.model"
  let broken ← IO.FS.readBinFile "logs/r9/broken.model"
  let freshCopy ← IO.FS.readBinFile "logs/r9/fresh-copy.model"
  let pinned ← IO.FS.readBinFile "logs/r9/pinned.model"
  let proof ← IO.FS.readBinFile "logs/r9/honest.proof.expr"
  expect "pinned environment lacks R9Candidate.honest" (base.env.find? `R9Candidate.honest).isSome false
  expect "pinned environment lacks complete theorem" (base.env.find? `R9Candidate.honest_lawful).isSome false
  expect "honest carried definitions check" (context base honest).isSome true
  expect "well-typed unlawful definitions check" (context base broken).isSome true
  expect "fresh copy of identical Lawful declaration" (context base freshCopy).isSome true
  expect "attempted pinned-name redefinition" (context base pinned).isSome false
  -- Put each malformed declaration before the unchanged honest declarations. The final goal
  -- is still the valid honest machine, so only validation of each earlier body blocks it.
  let fresh := (constBytes "R9Candidate.unused").drop 1 |>.dropLast
  let nat := constBytes "Nat"
  let addAux := fun (left right : List UInt8) =>
    "R9M1".toUTF8 ++ ([3] ++ fresh ++ left ++ right).toByteArray ++ honest.extract 5 honest.size
  let naturalZero : List UInt8 := [7, 0]
  for (label, model) in [
      ("valid additional declaration", addAux nat naturalZero),
      ("self-reference", addAux nat (constBytes "R9Candidate.unused")),
      ("wrong body type", addAux nat (constBytes "Bool.true")),
      ("claimed type is a value", addAux naturalZero naturalZero),
      ("unknown constant", addAux nat (constBytes "R9Candidate.absent"))] do
    expect label (context base model).isSome (label == "valid additional declaration")
  -- The proper proof must pass, while a complete proof for the same declaration name under
  -- a different definition must fail. Refusals leave the shared pinned context untouched.
  for (label, model, term, expected) in [
      ("new machine", honest, proof, true),
      ("changed unlawful body / honest proof", broken, proof, false),
      ("pinned Lawful / honest proof", pinned, proof, false),
      ("candidate theorem supplied by name", honest, (constBytes "R9Candidate.honest_lawful").toByteArray, false),
      ("truncated model", honest.extract 0 (honest.size - 1), proof, false),
      ("truncated proof", honest, proof.extract 0 (proof.size - 1), false),
      ("recheck from pinned environment", honest, proof, true)] do
    expect label (check base model term) expected
