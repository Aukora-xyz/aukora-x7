import Radio
/-! The door between the Wasm file and the proved text. Nothing here decides anything: it unpacks bytes and calls
`Radio.decision`, `Radio.belief`, `Radio.rest`, `Radio.doubt` and the three decidable laws of `judge/Radio.lean`,
the very definitions the four universal theorems are stated about.

Input bytes: 96 weights (each 0, 1 or 2), then any number of lines of five bytes (source, side, kind, level, age).
Anything else is refused with the value 0xFFFFFFFF. -/
namespace Radio

def lineAt (b : ByteArray) (i : Nat) : Line :=
  ⟨(b.get! i).toNat, (b.get! (i + 1)).toNat, (b.get! (i + 2)).toNat, (b.get! (i + 3)).toNat, (b.get! (i + 4)).toNat⟩

def weightsOf (b : ByteArray) : List Nat := (List.range 96).map fun i => (b.get! i).toNat
def linesOf (b : ByteArray) : List Line := (List.range ((b.size - 96) / 5)).map fun k => lineAt b (96 + 5 * k)

def wellFormed (b : ByteArray) : Bool :=
  decide (96 ≤ b.size) && decide ((b.size - 96) % 5 = 0) && (List.range 96).all fun i => decide ((b.get! i).toNat < 3)

/-- decision in the low byte, then belief, rest, doubt (each at most 144). -/
@[export radio_decide] def decideBytes (b : ByteArray) : UInt32 :=
  if wellFormed b then
    let w := weightsOf b; let E := linesOf b
    (decision w E).toUInt32 ||| ((belief w E).toUInt32 <<< 8) ||| ((rest w E).toUInt32 <<< 16) ||| ((doubt w E).toUInt32 <<< 24)
  else 0xFFFFFFFF

/-- bit 0 DEAF, bit 1 NO LOUDER THAN THE MATCH, bit 2 TRUE TO ITS SIDE. -/
@[export radio_laws] def lawBits (b : ByteArray) : UInt32 :=
  if wellFormed b then
    let w := weightsOf b
    (if Deaf w then 1 else 0) ||| (if NoAmp w then 2 else 0) ||| (if SideTrue w then 4 else 0)
  else 0xFFFFFFFF

/-- The two energies and the honest coupling, for reports. At most 4,096 lines reach this door (the buffer in
    `interface.c`), each worth at most 144, so the values stay far below 2^32. -/
@[export radio_for] def forBytes (b : ByteArray) : UInt32 :=
  if wellFormed b then (forE (weightsOf b) (linesOf b)).toUInt32 else 0xFFFFFFFF
@[export radio_against] def againstBytes (b : ByteArray) : UInt32 :=
  if wellFormed b then (agE (weightsOf b) (linesOf b)).toUInt32 else 0xFFFFFFFF
@[export radio_honest] def honestBytes (b : ByteArray) : UInt32 :=
  if wellFormed b then (honest (linesOf b)).toUInt32 else 0xFFFFFFFF

/-- The door adds nothing: for a well-formed input the low byte IS `decision` of the unpacked weights and lines. -/
theorem door_is_decision (b : ByteArray) (ok : wellFormed b = true) :
    decideBytes b = ((decision (weightsOf b) (linesOf b)).toUInt32 ||| ((belief (weightsOf b) (linesOf b)).toUInt32 <<< 8) |||
      ((rest (weightsOf b) (linesOf b)).toUInt32 <<< 16) ||| ((doubt (weightsOf b) (linesOf b)).toUInt32 <<< 24)) := by
  simp [decideBytes, ok]

#print axioms door_is_decision
end Radio
