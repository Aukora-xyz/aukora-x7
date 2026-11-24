import core.Mldsa8

/-- Run exactly the same independently generated binary vectors as the Wasm test. -/
def main (args : List String) : IO Unit := do
  let path : String := args[0]?.getD "logs/r8/build/vectors"
  let dir := System.FilePath.mk path
  let start := (args[1]?.bind String.toNat?).getD 0
  let count := (args[2]?.bind String.toNat?).getD 1000000
  let index ← IO.FS.readFile (dir / "index.tsv")
  let rows := (index.splitOn "\n").filter (· != "")
  let selected := (rows.drop start).take count
  if selected.isEmpty then throw (IO.userError "empty vector selection")
  let mut accepted := 0
  for row in selected do
    let [label, expected, keyPath, msgPath, sigPath] := row.splitOn "\t"
      | throw (IO.userError ("bad vector index line: " ++ row))
    let key ← IO.FS.readBinFile (dir / keyPath)
    let msg ← IO.FS.readBinFile (dir / msgPath)
    let sig ← IO.FS.readBinFile (dir / sigPath)
    let result := Aukora.Mldsa8.verify key msg sig
    if (expected != "0" && expected != "1") || result != (expected == "1") then
      throw (IO.userError s!"{label}: got {result}, expected {expected}")
    if result then accepted := accepted + 1
  IO.println s!"PASS native rows {start}..{start + selected.length - 1}: {accepted} accepted, {selected.length - accepted} refused"
