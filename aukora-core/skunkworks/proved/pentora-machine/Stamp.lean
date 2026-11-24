import Sharper

namespace Pentora

inductive Kind | truth | safety
  deriving DecidableEq, Repr

/-- Search downward for the highest corner owned by both organs. -/
def higherOf (a b : Fin 5) : Fin 20 :=
  ((fins 20).reverse.find? fun v => owns a v && owns b v).getD 0

/-- For distinct organs, truth names their lower corner and safety names their higher corner. -/
def cornerOf (a b : Fin 5) (k : Kind) : Fin 20 :=
  match k with
  | .truth => blindOf a b
  | .safety => higherOf a b

def kindOf (v : Fin 20) : Kind :=
  if v = blindOf (home1 v).1 (home2 v).1 then .truth else .safety

/-- For two distinct organs the truth corner has a strictly lower index than the safety corner. -/
theorem corner_order : ∀ a b : Fin 5, a ≠ b → cornerOf a b .truth < cornerOf a b .safety := by
  decide +kernel

/-- For two distinct organs and either kind, the owners of the selected corner are those two organs in some order. -/
theorem corner_owners (k : Kind) : ∀ a b : Fin 5, a ≠ b → let v := cornerOf a b k
    ((home1 v).1 = a ∧ (home2 v).1 = b) ∨ ((home1 v).1 = b ∧ (home2 v).1 = a) := by
  cases k <;> decide +kernel

/-- For either kind, swapping the organs leaves the selected corner unchanged. -/
theorem corner_symm (k : Kind) : ∀ a b : Fin 5, cornerOf a b k = cornerOf b a k := by
  cases k <;> decide +kernel

/-- A corner's two owners select that corner for a given kind exactly when that kind is the corner's assigned kind. -/
theorem corner_kind_iff (k : Kind) : ∀ v : Fin 20, cornerOf (home1 v).1 (home2 v).1 k = v ↔ k = kindOf v := by
  cases k <;> decide +kernel

/-- The stamp accepts reports when the seam list is empty and each organ has health zero. -/
def go (R : Fin 5 → Report) : Bool :=
  decide (seams R = []) && (fins 5).all fun c => health (cellsOf (R c)) == 0

/-- The stamp accepts five reports exactly when both owners agree at every corner and every cell of every report passed. -/
theorem go_iff (R : Fin 5 → Report) : go R = true ↔ (∀ v, at1 R v = at2 R v) ∧ ∀ c, ∀ t ∈ cellsOf (R c), t = .pass := by
  simp [go, List.all_eq_true, mem_fins, seams_nil_iff, Compatible, health_zero_iff]

/-- Every cell in a report passed exactly when every private slot and every corner slot in it passed. -/
theorem report_pass_iff (r : Report) : (∀ t ∈ cellsOf r, t = .pass) ↔ (∀ i, r.priv i = .pass) ∧ ∀ j, r.corn j = .pass := by
  simp only [cellsOf, List.forall_mem_append, List.forall_mem_map, mem_fins, true_implies]

/-- If every organ other than one reports its true view of a body and a corner of that body did not pass, the stamp rejects the reports. -/
theorem one_part_cannot_force_go (g : Body) (R : Fin 5 → Report) (x : Fin 5) (honest : ∀ c, c ≠ x → R c = view g c)
    (v : Fin 20) (bad : g.corn v ≠ .pass) : go R = false := by
  cases accepted : go R with
  | false => rfl
  | true =>
    exfalso
    apply bad
    rw [← congrFun (heal_true g R x honest) v]
    have passed := ((go_iff R).1 accepted).2
    unfold heal
    split <;> exact ((report_pass_iff _).1 (passed _)).2 _

/-- The stamp accepts the five true views of a body exactly when all its private cells and all its shared corners passed. -/
theorem honest_go (g : Body) : go (view g) = true ↔ (∀ c i, g.priv c i = .pass) ∧ ∀ v, g.corn v = .pass := by
  constructor
  · intro h
    have passed (c : Fin 5) := (report_pass_iff _).1 (((go_iff _).1 h).2 c)
    refine ⟨fun c => (passed c).1, fun v => ?_⟩
    rw [← at1_view g v]
    exact (passed _).2 _
  · intro ⟨priv, corn⟩
    apply (go_iff _).2
    exact ⟨views_compatible g, fun c => (report_pass_iff _).2 ⟨priv c, fun j => corn (slot c j)⟩⟩

/-- If a cell in any organ's report did not pass, the stamp rejects the five reports. -/
theorem any_part_can_stop (R : Fin 5 → Report) (c : Fin 5) (t : Trit) (cell : t ∈ cellsOf (R c)) (bad : t ≠ .pass) : go R = false := by
  cases accepted : go R with
  | false => rfl
  | true => exact absurd (((go_iff R).1 accepted).2 c t cell) bad

private def passingBody : Body := ⟨fun _ _ => .pass, fun _ => .pass⟩

/-- There is a body with a nonpassing corner for which the stamp accepts reports even though every organ outside that corner's two owners reports its true view. -/
theorem two_owners_can_force : ∃ (g : Body) (v : Fin 20) (R : Fin 5 → Report), g.corn v ≠ .pass ∧
    (∀ c, c ≠ (home1 v).1 → c ≠ (home2 v).1 → R c = view g c) ∧ go R = true := by
  let g : Body := ⟨passingBody.priv, upd passingBody.corn 0 .fail⟩
  refine ⟨g, 0, view passingBody, by decide, ?_, ?_⟩
  · intro c h₁ h₂
    exact (view_upd passingBody 0 .fail c h₁.symm h₂.symm).symm
  · exact (honest_go _).2 ⟨fun _ _ => rfl, fun _ => rfl⟩

/-- There is a body with a nonpassing private cell for which the stamp accepts reports even though every organ other than that cell's owner reports its true view. -/
theorem private_fault_can_be_hidden : ∃ (g : Body) (x : Fin 5) (i : Fin 18) (R : Fin 5 → Report), g.priv x i ≠ .pass ∧
    (∀ c, c ≠ x → R c = view g c) ∧ go R = true := by
  let g : Body := ⟨fun c i => if c = 0 ∧ i = 0 then .unknown else .pass, passingBody.corn⟩
  refine ⟨g, 0, 0, view passingBody, by decide, ?_, ?_⟩
  · intro c other
    apply Report.ext'
    · funext i
      simp [view, g, passingBody, other]
    · rfl
  · exact (honest_go _).2 ⟨fun _ _ => rfl, fun _ => rfl⟩

/-- If the Lean byte judge returns zero for a packet, the stamp accepts its decoded reports. -/
theorem judge_zero_means_go (b : ByteArray) (h : judge b = 0) : go (reportOf b) = true := by
  let pack (digit : Fin 5 → Nat) (cs : List (Fin 5)) := cs.foldr (fun c acc => digit c + 3 * acc) 0
  have digits (digit : Fin 5 → Nat) (bound : ∀ c, digit c ≤ 2) (cs : List (Fin 5)) :
      pack digit cs < 3 ^ cs.length ∧ (pack digit cs = 0 → ∀ c ∈ cs, digit c = 0) := by
    induction cs with
    | nil => exact ⟨Nat.zero_lt_succ 0, by simp⟩
    | cons a cs ih =>
      change digit a + 3 * pack digit cs < 3 ^ (cs.length + 1) ∧
        (digit a + 3 * pack digit cs = 0 → ∀ c ∈ a :: cs, digit c = 0)
      constructor
      · rw [Nat.pow_succ]
        have := bound a
        have := ih.1
        omega
      · intro hz c hc
        rcases List.mem_cons.1 hc with rfl | tail
        · omega
        · exact ih.2 (by omega) c tail
  obtain ⟨wf, noSeams⟩ := judge_agrees b (by rw [h]; decide)
  let d (c : Fin 5) := health (cellsOf (reportOf b c))
  have bound (c : Fin 5) : d c ≤ 2 := by
    unfold d health
    split
    · decide
    · split <;> decide
  obtain ⟨small, allZero⟩ := digits d bound (fins 5)
  rw [length_fins] at small
  have h32 : (healths (reportOf b)).toUInt32 = 0 := by
    simpa only [judge, wf, if_true, noSeams] using h
  -- Five base-three digits are below 3^5, so converting to UInt32 preserves their value.
  have zero : healths (reportOf b) = 0 := calc
    _ = healths (reportOf b) % 2 ^ 32 := (Nat.mod_eq_of_lt (Nat.lt_trans small (by decide : 3 ^ 5 < 2 ^ 32))).symm
    _ = (healths (reportOf b)).toUInt32.toNat := UInt32.toNat_ofNat'.symm
    _ = 0 := congrArg UInt32.toNat h32
  exact (go_iff _).2 ⟨(seams_nil_iff _).1 noSeams, fun c =>
    (health_zero_iff _).1 (allZero zero c (mem_fins c))⟩

end Pentora
