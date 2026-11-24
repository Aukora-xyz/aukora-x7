import Xor

namespace PCW

/-- One signed parameter step. The XOR coefficients are in {−1,0,1}, away from int8 limits. -/
structure Edit where
  offset : Fin 9
  increase : Bool
  deriving DecidableEq, Repr

def edits : List Edit :=
  (List.finRange 9).flatMap fun i => [⟨i,false⟩, ⟨i,true⟩]

def mutatedBytes (e : Edit) : List UInt8 :=
  xorBytes.modify e.offset.val fun w => if e.increase then w + 1 else w - 1

def survives (e : Edit) : Bool :=
  match decode (mutatedBytes e) with
  | none => false
  | some n => decide (Meets n xorSpec)

theorem distinct_mutants :
    edits.length = 18 ∧ (edits.map mutatedBytes).Nodup ∧ xorBytes ∉ edits.map mutatedBytes := by
  decide

theorem xor_survivors : edits.filter survives = [⟨1,false⟩, ⟨3,false⟩] := by decide

/-- The first survivor has its own proof even though the previous certificate fails to type-check. -/
theorem survivor_certificate : Certificate [1,254,0,255,1,0,1,1,0] xorSpec :=
  ⟨⟨⟨1,254,0⟩, ⟨255,1,0⟩, ⟨1,1,0⟩⟩, rfl, by decide⟩

#print axioms distinct_mutants
#print axioms xor_survivors
#print axioms survivor_certificate
#eval edits.filter survives

end PCW
