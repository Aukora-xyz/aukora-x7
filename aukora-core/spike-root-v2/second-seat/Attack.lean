/-! Second seat: two questions the spike does not ask. Appended to a copy of Spike.lean and checked together. -/
namespace RootV2Spike
/-- Q1. In the spike's bound start, is the OLD key change (which signs no identifier and no head) still open? -/
theorem bound_start_leaves_old_key_change_open (I keys : Nat) : open_ (bound I keys) .oldKeyChange = true := by rfl
/-- Q1b. So one old key-change frame, valid under the keys alone, is admitted by two bound records with DIFFERENT identifiers. -/
theorem old_key_change_travels (keys k σ : Nat) :
    (step (fun _ _ _ => true) (bound 7 keys) (.oldKeyChange k σ)).isSome = true ∧
    (step (fun _ _ _ => true) (bound 8 keys) (.oldKeyChange k σ)).isSome = true := by constructor <;> rfl
/-- Q2. Can the owner, with the STRONG guard, end with no approval form at all, for ever? -/
theorem approvals_can_be_refused_for_ever :
    let s := run (step (fun _ _ _ => true)) (bound 7 1) [.refuse .boundApproval 0 0]
    (∀ i σ, step (fun _ _ _ => true) s (.boundApproval i σ) = none) ∧ (∀ i σ, step (fun _ _ _ => true) s (.legacyApproval i σ) = none) ∧ Usable s := by
  refine ⟨fun _ _ => rfl, fun _ _ => rfl, usable_run _ _ (starts_usable 7 1).2⟩
#print axioms old_key_change_travels
#print axioms approvals_can_be_refused_for_ever
end RootV2Spike
