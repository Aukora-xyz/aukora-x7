import Stamp

namespace Pentora

/-- Check only the four online reports and the corners where both owners are online. -/
def go4 (R : Fin 5 → Report) (x : Fin 5) : Bool :=
  let corners := (fins 20).filter fun v => decide ((home1 v).1 ≠ x ∧ (home2 v).1 ≠ x)
  let online := (fins 5).filter fun c => decide (c ≠ x)
  (corners.all fun v => at1 R v == at2 R v) &&
    (online.all fun c => health (cellsOf (R c)) == 0)

theorem go4_iff (R : Fin 5 → Report) (x : Fin 5) : go4 R x = true ↔
    (∀ v, (home1 v).1 ≠ x → (home2 v).1 ≠ x → at1 R v = at2 R v) ∧
    ∀ c, c ≠ x → ∀ t ∈ cellsOf (R c), t = .pass := by
  simp only [go4, Bool.and_eq_true, List.all_eq_true, List.mem_filter, mem_fins,
    true_and, decide_eq_true_eq, beq_iff_eq, and_imp, health_zero_iff]

theorem go_gives_go4 (R : Fin 5 → Report) (x : Fin 5) : go R = true → go4 R x = true := by
  intro h
  obtain ⟨agree, passed⟩ := (go_iff R).1 h
  exact (go4_iff R x).2 ⟨fun v _ _ => agree v, fun c _ => passed c⟩

theorem honest_go4 (g : Body) (R : Fin 5 → Report) (x : Fin 5)
    (honest : ∀ c, c ≠ x → R c = view g c) :
    go4 R x = true ↔ (∀ c, c ≠ x → ∀ i, g.priv c i = .pass) ∧ ∀ v, g.corn v = .pass := by
  rw [go4_iff]
  constructor
  · intro ⟨_, passed⟩
    have slotsPass (c : Fin 5) (hc : c ≠ x) := (report_pass_iff _).1 (passed c hc)
    constructor
    · intro c hc
      have hp := (slotsPass c hc).1
      rw [honest c hc] at hp
      exact hp
    · intro v
      rw [← congrFun (heal_true g R x honest) v]
      unfold heal
      split
      next h => exact (slotsPass _ (fun k => (homes v).2.2 (h.trans k.symm))).2 _
      next h => exact (slotsPass _ h).2 _
  · intro ⟨priv, corn⟩
    constructor
    · intro v h₁ h₂
      unfold at1 at2
      rw [honest _ h₁, honest _ h₂]
      exact views_compatible g v
    · intro c hc
      rw [honest c hc]
      exact (report_pass_iff _).2 ⟨priv c hc, fun j => corn (slot c j)⟩

/-- The two owners of a corner are x and y, in either order. -/
abbrev SharedBy (v : Fin 20) (x y : Fin 5) : Prop :=
  ((home1 v).1 = x ∧ (home2 v).1 = y) ∨ ((home1 v).1 = y ∧ (home2 v).1 = x)

theorem one_part_cannot_force_go4 (g : Body) (R : Fin 5 → Report) (x y : Fin 5) (_distinct : y ≠ x)
    (honest : ∀ c, c ≠ x → c ≠ y → R c = view g c) (v : Fin 20)
    (bad : g.corn v ≠ .pass) (unshared : ¬ SharedBy v x y) : go4 R x = false := by
  cases h : go4 R x with
  | false => rfl
  | true =>
    exfalso
    apply bad
    have fromOwner (c : Fin 5) (j : Fin 8) (cx : c ≠ x) (cy : c ≠ y)
        (atCorner : slot c j = v) : g.corn v = .pass := by
      have hp := ((report_pass_iff _).1 (((go4_iff R x).1 h).2 c cx)).2 j
      rw [honest c cx cy] at hp
      simpa only [view, atCorner] using hp
    have distinct := (homes v).2.2
    by_cases ax : (home1 v).1 = x
    · exact fromOwner _ _ (fun bx => distinct (ax.trans bx.symm))
        (fun by' => unshared (.inl ⟨ax, by'⟩)) (homes v).2.1
    · by_cases ay : (home1 v).1 = y
      · exact fromOwner _ _ (fun bx => unshared (.inr ⟨ay, bx⟩))
          (fun by' => distinct (ay.trans by'.symm)) (homes v).2.1
      · exact fromOwner _ _ ax ay (homes v).1

theorem offline_neighbour_can_force : ∃ (g : Body) (x y : Fin 5) (v : Fin 20) (R : Fin 5 → Report),
    y ≠ x ∧ SharedBy v x y ∧ g.corn v ≠ .pass ∧
    (∀ c, c ≠ x → c ≠ y → R c = view g c) ∧ go4 R x = true := by
  let clean : Body := ⟨fun _ _ => .pass, fun _ => .pass⟩
  let g : Body := ⟨clean.priv, upd clean.corn 0 .fail⟩
  refine ⟨g, 0, 1, 0, view clean, by decide, .inl ⟨rfl, rfl⟩, by decide, ?_, ?_⟩
  · intro c cx cy
    exact (view_upd clean 0 .fail c cx.symm cy.symm).symm
  · exact go_gives_go4 _ _ ((honest_go clean).2 ⟨fun _ _ => rfl, fun _ => rfl⟩)

theorem two_unwitnessed_corners (x y : Fin 5) (distinct : x ≠ y) :
    ((fins 20).filter fun v => decide (SharedBy v x y)).length = 2 :=
  two_witnesses x y distinct

end Pentora
