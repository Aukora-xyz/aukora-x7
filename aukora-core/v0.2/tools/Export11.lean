import tests.SuccessionCandidates
import tools.Serialization
import Lean.Util.ReplaceExpr
import Lean.Util.InstantiateLevelParams

open Lean Elab.Command Release.Serialization

namespace Release.Export11

private def out (name : String) := "v0.2/.work/package/" ++ name

private def file (name : String) (bytes : ByteArray) : CommandElabM Unit := do
  liftIO <| IO.FS.writeBinFile (out name) bytes
  logInfo m!"{name}: {bytes.size} bytes"

private def serialize (e : Expr) : CommandElabM (List UInt8) := do
  let .ok bytes := exprBytes true e | throwError "could not serialize kernel expression"
  return bytes

private def assembly (type : Expr) : Bool :=
  let head := type.getForallBody.getAppFn
  head.isConstOf ``Aukora.Release.Lawful || head.isConstOf ``Aukora.Ratchet11.Lawful ||
    head.isConstOf ``Aukora.Ratchet11.Cases.strong

-- Carry the complete assembly; only component theorem statements enter the snapshot.
private def expanded (name : Name) : CommandElabM Expr := do
  let env ← getEnv
  let .thmInfo t ← getConstInfo name | throwError "not a theorem: {name}"
  let mut proof := t.value
  for _ in [:64] do
    let mut expand : NameMap TheoremVal := {}
    for n in proof.getUsedConstants do
      if let some (.thmInfo thm) := env.find? n then
        if assembly thm.type || n == `Aukora.Bound5.wrong_digest then
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
    if name == ``sorryAx || name == `Aukora.Bound5.wrong_digest then
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

open Aukora

private def lawName := `R9Candidate.claimedLaw
private def machineName := `R9Candidate.successor

/-- The leading declaration carries the closed law, the final declaration carries the model. -/
private def modelFile (label : String) (clause : Expr) (m : Name) : CommandElabM Unit := do
  let ty := Expr.forallE `m (mkConst ``Aukora.Release.Model) (.sort .zero) .default
  let put (n : Name) (t v : Expr) : CommandElabM (List UInt8) := do
    return putName n ++ (← serialize t) ++ (← serialize v)
  let first ← put lawName ty clause
  let last ← put machineName (mkConst ``Aukora.Release.Model) (mkConst m)
  file (label ++ ".model") ("R9M1".toUTF8 ++ (varNat 2 ++ first ++ last).toByteArray)

/-- Inline extra predicates so the stronger child can introduce its law without pinning its name in advance. -/
private def unfoldCases (e : Expr) : CommandElabM Expr := do
  let env ← getEnv
  return e.replace fun sub => do
    let .const n _ := sub | none
    guard ([``Ratchet11.Cases.strong, ``Ratchet11.Cases.bottom].contains n)
    let some (.defnInfo d) := env.find? n | none
    return d.value

private def package (basis : Nat) (prior child machine sat ent old : Expr) : CommandElabM Expr := do
  let priorBytes := (← serialize prior).toByteArray
  let id := RatchetChecker.number (RatchetChecker.identity basis priorBytes)
  return .letE `foundation (.const ``Nat []) (.lit (.natVal basis))
    (.letE `previous (.const ``Nat []) (.lit (.natVal id))
      (.letE `satisfaction (.app child machine) sat
        (.letE `entailment (RatchetChecker.entailmentGoal child prior) ent old true) true) true) true

run_cmd
  liftIO <| IO.FS.createDirAll "v0.2/.work/package"
  let env ← getEnv
  let inherited := (getStructureFields env ``Aukora.Release.Lawful).toList.map toString
  unless inherited == RatchetChecker.inheritedNames do throwError "manifest differs from v0.1 law fields: {inherited}"
  let r11 := (getStructureFields env ``Ratchet11.Lawful).toList.map toString
  unless r11 == ["inherited","succession"] do throwError "manifest differs from R11 law fields: {r11}"
  let root := mkConst ``Ratchet11.Lawful
  let extra ← unfoldCases (mkConst ``Ratchet11.Cases.strong)
  let weak := mkConst ``Aukora.Release.Lawful
  let bottom ← unfoldCases (mkConst ``Ratchet11.Cases.bottom)
  let newMachine := mkConst ``Ratchet11.model
  let oldMachine := mkConst ``Aukora.Release.newest
  let sat ← expanded ``Ratchet11.Cases.same_sat
  let strongSat ← unfoldCases (← expanded ``Ratchet11.Cases.strong_sat)
  let inherit_ ← expanded ``Ratchet11.legacy_lawful
  let weakSat ← expanded ``Aukora.Release.newest_lawful
  let ent ← expanded ``Ratchet11.Cases.same_entails
  let strongEnt ← unfoldCases (← expanded ``Ratchet11.Cases.strong_entails)
  let selfEnt ← unfoldCases (← expanded ``Ratchet11.Cases.strong_self)
  let absurdEnt ← unfoldCases (← expanded ``Ratchet11.Cases.bottom_entails)
  let rows := [
    ("same", root, root, newMachine, sat, ent, inherit_),
    ("strong", root, extra, newMachine, strongSat, strongEnt, inherit_),
    ("weak", root, weak, oldMachine, weakSat, ent, weakSat),
    ("weak-claims-root", root, root, oldMachine, weakSat, ent, weakSat),
    ("bottom", root, bottom, newMachine, sat, absurdEnt, inherit_),
    ("same-on-strong", extra, root, newMachine, sat, ent, inherit_),
    ("strong-on-strong", extra, extra, newMachine, strongSat, selfEnt, inherit_)]
  let mut roots := [mkConst ``Aukora.Release.Model, root]
  for (_,prior,child,m,own,ratchet,old) in rows do
    roots := (← package 0 prior child m own ratchet old) :: roots
  snapshot roots [lawName,machineName]
  let bytes ← liftIO <| IO.FS.readBinFile (out "laws.env")
  let basis := RatchetChecker.number (Sha256.hash bytes)
  for (label,prior,child,m,own,ratchet,old) in rows do
    if !label.endsWith "-on-strong" then modelFile label child m.constName!
    let expr ← package basis prior child m own ratchet old
    file (label ++ ".proof.expr") (← serialize expr).toByteArray
  let rootBytes := (← serialize root).toByteArray
  unless rootBytes.data == RatchetChecker.rootSpec.data do throwError "root declaration encoding"
  file "root.law" rootBytes
  file "strong.law" (← serialize extra).toByteArray

end Release.Export11
