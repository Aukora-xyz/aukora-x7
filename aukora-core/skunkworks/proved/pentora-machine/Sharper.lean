import Entry
/-! # Sharper forms of five statements

Written after an outside review found that the words around some theorems of `Pentora.lean` said more than the
theorems. Nothing in `Pentora.lean` or `Entry.lean` is changed. Each theorem here says exactly one thing. -/
namespace Pentora

/-- NAMING ONE FALSE ORGAN, exactly. Suppose the four organs other than x report the body truly, and the reports
    disagree at two corners whose only common owner is x. Then x is a suspect and it is the only one. (With no disagreement there
    are no suspects; with disagreements against one neighbour only, there are two.) -/
theorem convicted_alone (g : Body) (R : Fin 5 → Report) (x : Fin 5) (honest : ∀ c, c ≠ x → R c = view g c)
    (v w : Fin 20) (mv : v ∈ seams R) (mw : w ∈ seams R)
    (only : ∀ c, owns c v = true → owns c w = true → c = x) :
    x ∈ suspects R ∧ ∀ c, c ∈ suspects R → c = x :=
  ⟨liar_among_suspects g R x honest (fun e => by rw [e] at mv; cases mv), convicted R x v w mv mw only⟩

/-- A corner changed leaves an organ's view alone when that organ does not own the corner. -/
theorem view_upd (g : Body) (v : Fin 20) (t : Trit) (c : Fin 5) (n1 : (home1 v).1 ≠ c) (n2 : (home2 v).1 ≠ c) :
    view ⟨g.priv, upd g.corn v t⟩ c = view g c := by
  apply Report.ext'
  · rfl
  · funext j
    show upd g.corn v t (slot c j) = g.corn (slot c j)
    have ne : slot c j ≠ v := by
      intro k
      rcases slots c j with e | e
      · exact n1 (by rw [← k, e])
      · exact n2 (by rw [← k, e])
    unfold upd; rw [if_neg ne]

/-- One step round the three values. -/
def bump (t : Trit) : Trit := Trit.ofCode (t.code + 1)
/-- The body with one corner moved one step. -/
def shift (g : Body) (v : Fin 20) : Body := ⟨g.priv, upd g.corn v (bump (g.corn v))⟩

theorem bump3 (t : Trit) : bump (bump (bump t)) = t := by cases t <;> decide

/-- THE SHIFT IS UNSEEN BY THREE. Leave out two organs x and y and move the corner only they own: the other three
    organs see exactly what they saw. -/
theorem shift_unseen (g : Body) (x y : Fin 5) (hxy : x ≠ y) (c : Fin 5) (cx : c ≠ x) (cy : c ≠ y) :
    view (shift g (blindOf x y)) c = view g c := by
  have hv := blind_corner x y hxy
  apply view_upd
  · rcases hv with ⟨a, _⟩ | ⟨a, _⟩
    · rw [a]; exact fun k => cx k.symm
    · rw [a]; exact fun k => cy k.symm
  · rcases hv with ⟨_, b⟩ | ⟨_, b⟩
    · rw [b]; exact fun k => cy k.symm
    · rw [b]; exact fun k => cx k.symm

/-- THE SHIFT MOVES THE SEAL BY ONE. -/
theorem shift_seal (g : Body) (v : Fin 20) : sealOf (shift g v) = (sealOf g + 1) % 3 := by
  have h := seal_upd g v (bump (g.corn v))
  have hc : (bump (g.corn v)).code = ((g.corn v).code + 1) % 3 := code_ofCode _
  have ho := code_lt (g.corn v)
  show sumC (upd g.corn v (bump (g.corn v))) (fins 20) % 3 = (sumC g.corn (fins 20) % 3 + 1) % 3
  omega

/-- THREE SHIFTS COME BACK to the same body. That the bodies then fall into cycles of three is an inference in prose;
    Lean states only this. -/
theorem shift_cycle (g : Body) (v : Fin 20) : shift (shift (shift g v) v) v = g := by
  apply Body.ext'
  · rfl
  · funext u
    by_cases e : u = v
    · subst e; simp [shift, upd, bump3]
    · simp [shift, upd, e]

/-! Read together, the three theorems above are the counting step of the usual secrecy argument for this way of
    sharing: the bodies that look a given way to three organs fall into cycles g, shift g, shift (shift g), one body for each seal. If the
    blind corner was filled at random, evenly, then what three organs see says nothing about the seal. The theorems
    are about counting; no statement about chance is made in Lean. -/

/-- The address needs 175 bits: it is below 2^175 and can reach 2^174. -/
theorem address_bits : 3 ^ 110 < 2 ^ 175 ∧ 2 ^ 174 < 3 ^ 110 := by decide

theorem seam_code_is_large : ∀ v : Fin 20, ¬ ((256 + v.val).toUInt32 < 256) := by decide +kernel

/-- WHAT THE LEAN FUNCTION `judge` SAYS (the function exported to the Wasm file; this is about its Lean text, not the
    compiled bytes), on the bytes themselves. An answer below 256 means the input was 130 bytes of
    0, 1, 2 AND the five reports agree; then exactly one body stands behind them (`no_seam_one_body`). -/
theorem judge_agrees (b : ByteArray) (h : judge b < 256) :
    wellFormed b = true ∧ seams (reportOf b) = [] := by
  unfold judge at h
  cases wf : wellFormed b with
  | false =>
    rw [wf] at h
    simp only [Bool.false_eq_true, if_false] at h
    exact absurd h (by decide)
  | true =>
    rw [wf] at h
    simp only [if_true] at h
    cases s : seams (reportOf b) with
    | nil => exact ⟨rfl, rfl⟩
    | cons v vs => rw [s] at h; exact absurd h (seam_code_is_large v)

end Pentora
