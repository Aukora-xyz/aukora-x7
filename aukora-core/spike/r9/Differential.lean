import core.Core9

open Aukora

namespace Diff9

private def zeroDigest : Digest := ⟨List.replicate 32 0⟩
private def intent (nonce : Nat) : Intent := ⟨.deliver [7, 17], "service", 0, nonce⟩
private def installedIntent : Intent := ⟨.install zeroDigest, "core", 0, 1⟩
private def fill (n : Nat) (b : UInt8 := 0) : ByteArray := ⟨Array.replicate n b⟩

structure Run where
  ctx : R6.KernelCell.Context
  machine : Policy9.Machine
  index : IO.FS.Handle
  binary : IO.FS.Handle
  count : Nat := 0
  accepted : Nat := 0

private abbrev Gen := StateT Run IO

private def here : Gen (Digest × Nat) := do
  let s := (← get).machine
  return (s.base.hybrid.inner.ledger.head, Policy9.nextSeq s)

private def pack (tag : UInt8) (body : Bytes) : Gen ByteArray := do
  let (head, seq) ← here
  return (tag :: (head.bytes ++ Wire4.putUInt 8 seq ++ body)).toByteArray

private def submit (label : String) (wire : ByteArray) : Gen Unit := do
  let s ← get
  let result := Core9.step s.ctx wire s.machine
  let next := result.getD s.machine
  let head := next.base.hybrid.inner.ledger.head
  let actual := if result.isSome then 1 else 0
  s.binary.write wire
  s.index.putStrLn s!"{label}\t{wire.size}\t{actual}\t{Wire5.keyName head.bytes}"
  set { s with machine := next, count := s.count + 1, accepted := s.accepted + actual }

/-- A mutation family around each real legacy grammar production, including R6/R7
certified headers. Header fields always come from the current Lean machine. -/
private def innerBody (tag seed : Nat) : Bytes :=
  let i := intent seed
  let blank := List.replicate 64 0
  match tag with
  | 0 => Wire5.putAction (.plain (.base (.say s!"case-{seed}")))
  | 1 => Wire5.putAction (.plain (.base (.remember (seed+100) 1 "记")))
  | 2 => Wire5.putAction (.plain (.base (.correct 100 101 s!"{seed}")))
  | 3 => Wire5.putAction (.grant i blank)
  | 4 => Wire5.putAction (.plain (.base (.act i)))
  | 5 => Wire5.putAction (.plain (.base (.outcome i .unknown)))
  | 6 => Wire5.putAction (.plain (.base (.advise "judge" seed)))
  | 7 => Wire5.putAction (.plain (.base (.upgrade zeroDigest true installedIntent)))
  | 8 => Wire5.putAction (.rebind zeroDigest.bytes blank)
  | 9 => Wire5.putAction (.control (.retract 1) blank)
  | 10 => Wire5.putAction (.control (.mandate ⟨"s", [17], 0, 3, 65535⟩) blank)
  | 11 => Wire5.putAction (.plain (.useMandate 1 (.act i)))
  | 12 => Wire5.putAction (.control (.grantBudget ⟨0, seed⟩) blank)
  | 13 => Wire5.putAction (.plain (.spend 0 seed))
  | 14 => Wire5.putAction (.control (.pass ⟨"a", "b", 0, 65535⟩) blank)
  | 15 => Wire5.putAction (.control (.revoke 0) blank)
  | 16 => Wire5.putAction (.plain (.read 0 "a" "b" true))
  | 17 => [17] ++ zeroDigest.bytes ++ Wire4.putBlob [7,17] ++ Wire4.putIntent installedIntent
  | _ => [18] ++ zeroDigest.bytes ++ Wire4.putUInt 4 2 ++ [7,17] ++ Wire4.putIntent installedIntent

private def matrices : Gen Unit := do
  for tag in [:19] do
    for variant in [:12] do
      let w ← pack 0 (innerBody tag (12*tag+variant))
      let bytes := match variant with
        | 0 => w.extract 0 1
        | 1 => w.extract 0 32
        | 2 => w.extract 0 40
        | 3 => w.extract 0 41
        | 4 => w.extract 0 42
        | 5 => w.extract 0 (w.size-1)
        | 6 => w
        | 7 => w.push 0
        | 8 => w.set! 1 (w[1]! ^^^ 255)
        | 9 => w.set! 33 (w[33]! ^^^ 1)
        | 10 => w.set! (w.size-1) 255
        | _ => w.set! 40 17
      submit s!"inner-{tag}-variant-{variant}" bytes
  for misplaced in [7,17] do
    let f : Wire5.Frame := ⟨⟨List.replicate 33 0⟩, misplaced * 256^7, .plain (.base (.say ""))⟩
    submit s!"malformed-parent-33-{misplaced}" (0 :: Wire5.encode f).toByteArray
  -- Every possible outer discriminator, including all reserved values. Content
  -- differs by case so unknown tags also exercise the short/default dispatch path.
  for tag in [:256] do
    submit s!"outer-{tag}" ((fill (1 + tag % 49) (UInt8.ofNat (tag+7))).set! 0 (UInt8.ofNat tag))
  -- Every possible discriminator in the underlying ordinary/certified decoder.
  for tag in [:256] do
    submit s!"inner-byte-{tag}" (← pack 0 [tag.toUInt8, 0, 0])
  -- Successful updates interleaved with refused current-head requests.
  for n in [:72] do
    let fields := match n % 4 with
      | 0 => innerBody 0 (700+n)
      | 1 => innerBody 6 (700+n)
      | 2 => innerBody 5 (700+n)
      | _ => innerBody 4 (700+n)
    submit s!"mixed-{n}" (← pack 0 fields)

private def lengthCases : Gen Unit := do
  submit "empty" ByteArray.empty
  for (tag, width) in ([(0,41), (19,3310), (20,5262), (21,106), (22,3415),
      (23,33), (24,49), (25,3446), (26,42), (27,77)] : List (UInt8 × Nat)) do
    for n in [width-1, width, width+1] do
      let (head,seq) ← here
      let h := ([tag] ++ head.bytes ++ Wire4.putUInt 8 seq).toByteArray
      submit s!"outer-{tag}-size-{n}" ((h ++ fill n).extract 0 n)
  -- Truncate/extend an otherwise well-formed new grant, revocation and correction.
  for (label,tag,body) in ([
      ("grant",24, Wire4.putUInt 8 65535 ++ Wire4.putIntent (intent 8191) ++ List.replicate 3373 0),
      ("cancel",25, zeroDigest.bytes ++ List.replicate 3373 0),
      ("correct",26, innerBody 5 8191)] : List (String × UInt8 × Bytes)) do
    let wire ← pack tag body
    for n in [wire.size-1,wire.size,wire.size+1] do
      submit s!"{label}-actual-{n}" ((wire.push 0).extract 0 n)
  -- u16 text/blob field at 255/256 and 65535/65536, including short and
  -- overlong payloads with a maximal declared length.
  for (declared, actual) in ([(0,0), (0,1), (1,0), (1,1), (255,255), (256,256),
      (65534,65534), (65535,65534), (65535,65535), (65535,65536), (0,65536)] : List (Nat × Nat)) do
    let w ← pack 0 (0 :: Wire4.putU16 declared)
    submit s!"u16-length-{declared}-actual-{actual}" (w ++ fill actual 65)
  for (declared, actual) in ([(0,0),(1,1),(255,255),(256,256),(65534,65534),
      (65535,65534),(65535,65535),(65535,65536),(0,65536)] : List (Nat × Nat)) do
    -- The bare act route always refuses in Core9. The decoder still has to parse
    -- the intent's u16 delivery-body field and consume the full frame.
    let w ← pack 0 ([4,0] ++ Wire4.putU16 declared)
    submit s!"u16-blob-{declared}-actual-{actual}" (w ++ fill actual 17 ++
      (Wire4.putText "s" ++ Wire4.putU16 0 ++ Wire4.putU16 7).toByteArray)
  for (name,raw) in ([("ascii7",[7]),("ascii17",[17]),("utf8-2",[194,128]),
      ("utf8-3",[224,160,128]),("utf8-4",[240,144,128,128]),("bad-utf8",[255]),
      ("short-utf8",[224,160]),("overlong-utf8",[192,128])] : List (String × Bytes)) do
    submit s!"ordinary-tag0-{name}" (← pack 0 (0 :: Wire4.putBlob raw))
  for r in [0,1,2,3,255] do
    submit s!"outcome-value-{r}" (← pack 0 (5 :: (Wire4.putIntent (intent (101+r)) ++ [r.toUInt8])))
  -- The grammar reads both length fields for these complete package forms. The
  -- staging buffer is empty here, so they cannot perform an installation.
  let cap := Upgrade9.maxCertificate
  for (m,p) in ([(0,1),(1,0),(1,1),(1,cap-2),(1,cap-1),(1,cap),
      (cap-2,1),(cap-1,1),(cap,1),(cap+1,1)] : List (Nat × Nat)) do
    let prefixBytes ← pack 27 (zeroDigest.bytes ++ Wire4.putUInt 4 m)
    let w := prefixBytes ++ fill m ++ (Wire4.putUInt 4 p).toByteArray ++ fill p ++
      (Wire4.putIntent installedIntent).toByteArray
    submit s!"model-len-{m}-proof-len-{p}" w
  -- ABI byte-buffer limit; an unrecognized tag keeps decoding constant time.
  -- The final case is rejected during input and then finishes the refusal via step.
  let capacity := 1024 * 1024 + 2 * 65535 + 128
  for n in [capacity-1,capacity,capacity+1] do
    submit s!"abi-size-{n}" (fill n 255)

private def signedTrace : Gen Unit := do
  let base := System.FilePath.mk "logs/r9/vector-signatures"
  let wires ← IO.FS.readBinFile (base / "frames.bin")
  let rows := (← IO.FS.readFile (base / "index.tsv")).splitOn "\n"
  let mut offset := 0
  for row in rows do
    if !row.isEmpty then
      let [label, count] := row.splitOn "\t" | throw (IO.userError row)
      let some size := count.toNat? | throw (IO.userError count)
      let wire := wires.extract offset (offset+size)
      if wire.size != size then throw (IO.userError s!"truncated {label}")
      -- Each well-formed envelope has immediate length -1/+1 probes at the same head.
      submit s!"signed-{label}-short" (wire.extract 0 (wire.size-1))
      submit s!"signed-{label}-long" (wire.push 0)
      submit s!"signed-{label}" wire
      offset := offset + size
  if offset != wires.size then throw (IO.userError "extra signed fixture bytes")

private def gateTrace : Gen Unit := do
  let dir := System.FilePath.mk "logs/r9/gate-vectors"
  let staged ← IO.FS.readBinFile "core/FixedGenesis9.wasm"
  modify fun s => {s with machine := Core9.feed staged s.machine}
  submit "gate-grant" (← IO.FS.readBinFile (dir / "grant.bin"))
  let wire ← IO.FS.readBinFile (dir / "upgrade.bin")
  submit "gate-short" (wire.extract 0 (wire.size-1))
  submit "gate-long" (wire.push 0)
  submit "gate-install" wire
  submit "gate-replay" wire

def generate (group : String) (dir : System.FilePath) : IO Unit := do
  let some ctx := Checker9.init (← IO.FS.readBinFile "logs/r7/laws.env") |
    throw (IO.userError "pinned kernel environment failed")
  let keysFile := if group == "gate" then "logs/r9/gate-vectors/keys.bin"
    else "logs/r9/vector-signatures/keys.bin"
  let some machine := Core9.genesis (← IO.FS.readBinFile keysFile) |
    throw (IO.userError "genesis failed")
  let tsv ← IO.FS.Handle.mk (dir / (group++".tsv")) .write
  let binary ← IO.FS.Handle.mk (dir / (group++".bin")) .write
  let start : Run := {ctx, machine, index := tsv, binary}
  let task : Gen Unit := match group with
    | "matrix" => matrices
    | "length" => lengthCases
    | "signed" => signedTrace
    | _ => gateTrace
  let (_,s) ← task.run start
  IO.println s!"Lean {group}: {s.count} verdicts and heads; {s.accepted} accepted; {s.count-s.accepted} refused"

end Diff9

def main (args : List String) : IO Unit := do
  let [group,path] := args | throw (IO.userError "expected GROUP OUTPUT_DIRECTORY")
  unless ["matrix","length","signed","gate"].contains group do throw (IO.userError "unknown group")
  IO.FS.createDirAll path
  Diff9.generate group path
