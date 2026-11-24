import core.Bound4

namespace Aukora.ModelSection9

def sectionName := "aukora.model.sha256".toUTF8

/-- WebAssembly varuint32 allows at most five bytes and only four value bits
    in the fifth byte. Positions are relative to the enclosing section limit. -/
private def varuint (bytes : ByteArray) (limit start : Nat) : Option (Nat × Nat) := do
  let mut value := 0
  for i in [:5] do
    let pos := start + i
    guard (pos < limit)
    let b := (← bytes[pos]?).toNat
    guard (i != 4 || b < 16)
    value := value + (b % 128) * 2^(7*i)
    if b < 128 then return (value, pos + 1)
  none

private def scan (bytes : ByteArray) : Nat → Nat → Option Digest → Option Digest
  | 0, _, _ => none
  | fuel+1, pos, found => do
    if pos == bytes.size then return ← found
    let id ← bytes[pos]?
    let (size, body) ← varuint bytes bytes.size (pos+1)
    let stop := body + size
    guard (stop ≤ bytes.size)
    if id != 0 then scan bytes fuel stop found else
      let (nameSize, name) ← varuint bytes stop body
      let payload := name + nameSize
      guard (payload ≤ stop)
      if nameSize == sectionName.size && (bytes.extract name payload).data == sectionName.data then
        guard (found.isNone && stop == payload + 32)
        scan bytes fuel stop (some ⟨(bytes.extract payload stop).data.toList⟩)
      else scan bytes fuel stop found

/-- Inspect section framing and demand exactly one 32-byte model commitment.
    Instruction validation and execution belong to the Wasm engine. -/
def read (bytes : ByteArray) : Option Digest := do
  guard ((bytes.extract 0 8).data.toList == ([0,97,115,109,1,0,0,0] : Bytes))
  scan bytes (bytes.size+1) 8 none

end Aukora.ModelSection9
