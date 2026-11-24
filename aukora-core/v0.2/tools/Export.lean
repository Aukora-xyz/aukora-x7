import tests.Candidates
import Compatibility.LegacyContract
import tools.Serialization
import Lean.Util.ReplaceExpr
import Lean.Util.InstantiateLevelParams

open Lean Elab.Command Release.Serialization

namespace Release.Export

private def out (name : String) := "v0.2/.work/r10-package/" ++ name

private def file (name : String) (bytes : ByteArray) : CommandElabM Unit := do
  liftIO <| IO.FS.writeBinFile (out name) bytes
  logInfo m!"{name}: {bytes.size} bytes"

private def serialize (e : Expr) : CommandElabM (List UInt8) := do
  let .ok bytes := exprBytes true e | throwError "could not serialize kernel expression"
  return bytes

private def carry (label : String) (names : List (Name × Name)) : CommandElabM (List Expr) := do
  let mut bytes := "R9M1".toUTF8 ++ (varNat names.length).toByteArray
  let mut roots := []
  for (source, carried) in names do
    let .defnInfo d ← getConstInfo source | throwError "expected definition {source}"
    unless d.levelParams.isEmpty && (d.safety matches .safe) do
      throwError "unsafe or polymorphic definition {source}"
    let record := putName carried ++ (← serialize d.type) ++ (← serialize d.value)
    bytes := bytes ++ record.toByteArray
    roots := d.type :: d.value :: roots
  file (label ++ ".model") bytes
  return roots

private def assembly (type : Expr) : Bool :=
  let head := type.getForallBody.getAppFn
  head.isConstOf ``Aukora.Release.Lawful || head.isConstOf ``Laws7.Lawful

-- Carry the complete assembly; only component theorem statements enter the snapshot.
private def expanded (name : Name) : CommandElabM Expr := do
  let env ← getEnv
  let .thmInfo t ← getConstInfo name | throwError "not a theorem: {name}"
  let mut proof := t.value
  for _ in [:64] do
    let mut expand : NameMap TheoremVal := {}
    for n in proof.getUsedConstants do
      if let some (.thmInfo thm) := env.find? n then
        if assembly thm.type || n == ``Aukora.Bound5.wrong_digest then
          expand := expand.insert n thm
    if RBMap.isEmpty expand then return proof
    proof := proof.replace fun e => do
      let .const n ls := e | none
      let thm ← expand.find? n
      return thm.value.instantiateLevelParams thm.levelParams ls
  throwError "certificate expansion exceeded bound"

private def snapshot (roots : List Expr) (carried : List Name) : CommandElabM Unit := do
  let mut seen := roots.foldl (fun names e => refsIn e names) {}
  let mut pending := RBTree.toList seen
  let mut payload := ByteArray.empty
  let mut index : Array String := #[]
  for _ in [:24000] do
    let name :: rest := pending | break
    pending := rest
    if carried.contains name then continue
    if name == ``sorryAx || name == ``Aukora.Bound5.wrong_digest then
      throwError "forbidden dependency {name}"
    let c ← getConstInfo name
    if c.isTheorem && assembly c.type then
      throwError "complete Lawful theorem would enter pinned environment: {name}"
    let .ok (bytes,deps,kind) := record c | throwError "unsupported declaration {name}"
    payload := payload ++ bytes.toByteArray
    if payload.size > 48 * 1024 * 1024 then throwError "snapshot exceeds 48 MiB at {name}"
    index := index.push s!"{kind}\t{name}\t{bytes.length}"
    for d in deps do
      if carried.contains d then
        throwError "pinned declaration {name} depends on unpinned candidate name {d}"
      unless seen.contains d do
        seen := seen.insert d
        pending := d :: pending
  unless pending.isEmpty do throwError "snapshot exceeds 24000 declarations"
  file "laws.env" ("R6E1".toUTF8 ++ (varNat index.size).toByteArray ++ payload)
  liftIO <| IO.FS.writeFile (out "laws.env.tsv") (String.intercalate "\n" index.toList ++ "\n")
  logInfo m!"pinned {index.size} declarations, excluding candidate and complete Lawful theorems"

run_cmd
  liftIO <| IO.FS.createDirAll "v0.2/.work/r10-package"
  let key := ``R9Candidate.fixedKey
  let good := ``R9Candidate.successor
  let bad := ``Aukora.Release.edOnly
  let oldKey := ``R9Candidate.ownerKey
  let goodRoots ← carry "honest" [(key,key), (good,good)]
  let badRoots ← carry "ed-only" [(oldKey,oldKey), (bad,good)]
  let goodProof ← expanded ``R9Candidate.successor_lawful
  let oldProof ← expanded ``Laws7.r6_lawful
  file "honest.proof.expr" (← serialize goodProof).toByteArray
  file "legacy.proof.expr" (← serialize oldProof).toByteArray
  let roots := [mkConst ``Aukora.Release.Lawful, mkConst ``Laws7.Lawful,
                mkConst ``Laws7.R6Machine, goodProof, oldProof] ++ goodRoots ++ badRoots
  snapshot roots [key,oldKey,good,bad]

end Release.Export
