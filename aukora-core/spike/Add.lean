/- Host, display, key custody, cryptography, Lean-to-Wasm compilation, and law selection
   are outside the proofs. Zero denotes refusal and one denotes acceptance. -/
@[export accept_length]
def acceptLength (expected actual length : UInt32) : UInt32 :=
  if expected = actual then
    if length = 0 then 0 else 1
  else 0

theorem acceptLength_spec (expected actual length : UInt32) :
    acceptLength expected actual length = 1 ↔ expected = actual ∧ length ≠ 0 := by
  by_cases same : expected = actual <;> by_cases empty : length = 0 <;>
    simp [acceptLength, same, empty]
#print axioms acceptLength_spec
