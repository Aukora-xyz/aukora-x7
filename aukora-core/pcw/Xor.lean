import Lattice

namespace PCW

/-- ReLU(x−y) + ReLU(y−x). The unsigned byte 255 encodes −1. -/
def xorNet : Lattice := ⟨⟨1,255,0⟩, ⟨255,1,0⟩, ⟨1,1,0⟩⟩
def xorBytes : List UInt8 := [1,255,0,255,1,0,1,1,0]

theorem xor_exact :
    Meets ⟨⟨1,255,0⟩, ⟨255,1,0⟩, ⟨1,1,0⟩⟩ xorSpec := by decide

theorem xor_certificate : Certificate [1,255,0,255,1,0,1,1,0] xorSpec :=
  ⟨xorNet, rfl, xor_exact⟩

theorem wrong_at_01 : run xorNet (false, true) = 1 ∧ andSpec (false, true) = 0 := by decide

theorem xor_refuses_and : ¬ Certificate xorBytes andSpec := by
  rintro ⟨n, hd, fits⟩
  have h : some xorNet = some n := hd
  cases Option.some.inj h
  exact (by decide : run xorNet (false, true) ≠ andSpec (false, true)) (fits false true)

#print axioms xor_exact
#print axioms xor_certificate
#print axioms wrong_at_01
#print axioms xor_refuses_and

end PCW
