import Round11

open Aukora

-- Replay identical published input bytes on the public Lean step.
def main (args : List String) : IO Unit := do
  let [group] := args | throw (IO.userError "expected vector group")
  let root := System.FilePath.mk "v0.2"
  let stream ← IO.FS.readBinFile (root / ".work/vectors" / (group ++ ".bin"))
  let manifest ← IO.FS.readFile (root / "vectors" / (group ++ ".tsv"))
  let keyfile := if group == "gate" then "install" else if group.startsWith "r11-" then group else "signed"
  let keys ← IO.FS.readBinFile (root / "fixtures" / keyfile / "keys.bin")
  let some ctx := RatchetChecker.init (← IO.FS.readBinFile (root / ".work/package/laws.env")) |
    throw (IO.userError "checker environment")
  let some initial := Core9.genesis keys | throw (IO.userError "genesis")
  let mut state := initial
  if group == "gate" then
    state := Core9.feed (← IO.FS.readBinFile "v0.1/fixtures/fixed-genesis.wasm") state
  let stages ← if group == "r11-install" then
    IO.FS.readFile (root / "fixtures" / group / "stages.tsv") else pure ""
  let mut offset := 0
  let mut count := 0
  let mut accepted := 0
  for row in manifest.trimRight.splitOn "\n" do
    let [label, len, expected, head] := row.splitOn "\t" | throw (IO.userError row)
    let some n := len.toNat? | throw (IO.userError row)
    let wire := stream.extract offset (offset + n)
    if let some stage := (stages.splitOn "\n").find? (·.startsWith (label ++ "\t")) then
      let [_, name] := stage.splitOn "\t" | throw (IO.userError stage)
      let bytes ← IO.FS.readBinFile (root / ".work/vectors/staged" / (name ++ ".wasm"))
      state := Core9.feed bytes (Core9.reset state)
    if group == "r11-safe" && label == "halted-no-valid-timed-grant" then
      unless Safe11.halted state && (Policy9.step wire state).isSome do
        throw (IO.userError "expected the original policy to admit this exact timed grant in halted state")
      IO.println "Frozen availability witness: original timed grant admits on the same halted state."
    let got := Round11.step ctx wire state
    state := got.getD state
    let currentHead := Wire5.keyName state.base.hybrid.inner.ledger.head.bytes
    unless wire.size == n && (if got.isSome then "1" else "0") == expected && currentHead == head do
      throw (IO.userError s!"{group} {label} expected {expected} {head}, got {got.isSome} {currentHead}")
    count := count + 1
    if got.isSome then accepted := accepted + 1
    offset := offset + n
  unless offset == stream.size do throw (IO.userError "trailing bytes")
  IO.println s!"Lean {group}: {count}/{count} agree on verdict and all 32 head bytes ({accepted} admitted)"
