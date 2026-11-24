import Stamp

namespace Pentora

/-- If a packet is well formed and the stamp accepts its decoded reports, the Lean function `judge` returns zero. -/
theorem go_means_judge_zero (b : ByteArray) (wf : wellFormed b = true) (h : go (reportOf b) = true) : judge b = 0 := by
  obtain ⟨noSeams, healthy⟩ : seams (reportOf b) = [] ∧ ∀ c, health (cellsOf (reportOf b c)) = 0 := by
    simpa [go, List.all_eq_true, mem_fins] using h
  have packed : healths (reportOf b) = 0 := by
    unfold healths
    induction fins 5 with
    | nil => rfl
    | cons c cs ih => rw [List.foldr_cons, ih, healthy, Nat.mul_zero, Nat.zero_add]
  simp [judge, wf, noSeams, packed]

/-- The Lean function `judge` returns zero exactly when the packet is well formed and the stamp accepts its decoded reports. -/
theorem judge_zero_iff (b : ByteArray) : judge b = 0 ↔ wellFormed b = true ∧ go (reportOf b) = true := by
  constructor
  · intro h
    exact ⟨(judge_agrees b (by rw [h]; decide)).1, judge_zero_means_go b h⟩
  · rintro ⟨wf, h⟩
    exact go_means_judge_zero b wf h

end Pentora
