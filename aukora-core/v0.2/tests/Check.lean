import Checker
import FixedGenesis

open Lean R6.KernelCell

private def read (name : String) := IO.FS.readBinFile ("v0.2/.work/r10-package/" ++ name)

private def expect (label : String) (value wanted : Bool) : IO Unit := do
  IO.println s!"{label}: {value} (expected {wanted})"
  unless value == wanted do throw (IO.userError label)

def main : IO Unit := do
  let published ← IO.FS.readBinFile "v0.1/fixtures/fixed-owner/keys.bin"
  let alternative ← IO.FS.readBinFile "v0.1/fixtures/signed/keys.bin"
  expect "distinct public genesis fixture" (published.data == alternative.data) false
  expect "fixed-key transformation of an alternative valid pair yields every published key byte"
    ((R9Candidate.fixedKey alternative).data == published.data) true
  let some base := Aukora.Checker9.init (← read "laws.env") | throw (IO.userError "pinned environment")
  let key := `R9Candidate.fixedKey
  let name := `R9Candidate.successor
  for n in [key, name, `R9Candidate.ownerKey, `R9Candidate.honest, `Laws7.r6_lawful,
            `Aukora.Release.edOnly, `Aukora.Release.newest_lawful, `R9Candidate.successor_lawful] do
    expect s!"excluded from pinned base: {n}" (base.env.find? n).isSome false
  let honest ← read "honest.model"
  let edOnly ← read "ed-only.model"
  let proof ← read "honest.proof.expr"
  let old ← read "legacy.proof.expr"
  let some historical := init (← IO.FS.readBinFile "logs/r7/laws.env")
    (← IO.FS.readBinFile "logs/r7/model.type.expr") | throw (IO.userError "round-seven context")
  let archived ← IO.FS.readBinFile "logs/r7/model.proof.expr"
  expect "original archived proof with its original pinned goal" (check historical archived) true
  expect "exact archived proof with the release goal" (Aukora.Checker9.check base honest archived) false
  expect "round-seven proof inhabits round-seven contract in same environment"
    (check {base with goal := mkApp (mkConst `Laws7.Lawful) (mkConst `Laws7.R6Machine)} old) true
  for (label, model) in [("newest fixed genesis", honest), ("legacy Ed-only adapter", edOnly)] do
    let some ctx := Aukora.Checker9.context base model | throw (IO.userError (label ++ " declarations"))
    expect (label ++ ": constructed target for same final name")
      (ctx.goal == mkApp (mkConst `Aukora.Release.Lawful) (mkConst name)) true
  expect "valid successor law" (Aukora.Checker9.check base honest proof) true
  expect "old theorem, same honest candidate" (Aukora.Checker9.check base honest old) false
  expect "Ed-only semantics, honest proof" (Aukora.Checker9.check base edOnly proof) false
  expect "Ed-only semantics, old proof" (Aukora.Checker9.check base edOnly old) false
