import Lattice

namespace PCW

/-- ReLU(x − ReLU(x−y)) is min(x,y) on bits. -/
def andNet : Lattice := ⟨⟨1,0,0⟩, ⟨1,255,0⟩, ⟨1,255,0⟩⟩

theorem and_exact :
    Meets ⟨⟨1,0,0⟩, ⟨1,255,0⟩, ⟨1,255,0⟩⟩ andSpec := by decide

theorem and_certificate : Certificate [1,0,0,1,255,0,1,255,0] andSpec :=
  ⟨andNet, rfl, and_exact⟩

#print axioms and_exact
#print axioms and_certificate

end PCW
