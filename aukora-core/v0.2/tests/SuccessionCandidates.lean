import RatchetLegacy

namespace Aukora.Ratchet11.Cases
open Release (Model)

def strong : Model → Prop := addLaw Lawful "standard-genesis" (fun m => m.genesis = Core9.genesis)
def bottom : Model → Prop := oneLaw "impossible" (fun _ => False)

theorem same_sat : Lawful model := ⟨legacy_lawful,model_succession⟩
theorem strong_sat : strong model := ⟨same_sat,rfl⟩
theorem same_entails (m : Model) (h : Lawful m) : Lawful m := h
theorem strong_entails (m : Model) (h : strong m) : Lawful m := h.1
theorem strong_self (m : Model) (h : strong m) : strong m := h
theorem bottom_entails (m : Model) (h : bottom m) : Lawful m := False.elim h
theorem bottom_uninhabited : ¬∃ m, bottom m := fun ⟨_,h⟩ => h
#print axioms bottom_uninhabited
#print axioms same_sat
#print axioms strong_sat
end Aukora.Ratchet11.Cases
