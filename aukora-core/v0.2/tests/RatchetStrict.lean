import tests.SuccessionCandidates

namespace Aukora.Ratchet11.Cases

/-- The original root set allows preprocessing all genesis inputs to empty; the added genesis law excludes that model. -/
theorem strictly_stronger (keys : ByteArray) (valid_start : (Core9.genesis keys).isSome = true) : ∃ m, Lawful m ∧ ¬ strong m := by
  let changed := Release.withGenesis model (fun _ => ByteArray.empty)
  have inherited := Release.lawful_withGenesis legacy_lawful (fun _ => ByteArray.empty)
  refine ⟨changed, ⟨inherited,model_succession⟩, ?_⟩
  intro h
  have same := congrFun h.2 keys
  have rhs := congrArg Option.isSome same
  rw [valid_start] at rhs
  change false = true at rhs
  contradiction

/-- A real checker initialization returns the digest of the bytes that furnished its declarations. -/
theorem initialized_basis {bytes ctx} (made : RatchetChecker.init bytes = some ctx) :
    RatchetChecker.basis ctx = some (RatchetChecker.number (Sha256.hash bytes)) := by
  unfold RatchetChecker.init at made
  obtain ⟨old,_,made⟩ := Option.bind_eq_some.mp made
  obtain ⟨_,_,made⟩ := Option.bind_eq_some.mp made
  cases Option.some.inj made
  rfl

#print axioms strictly_stronger
#print axioms initialized_basis
end Aukora.Ratchet11.Cases
