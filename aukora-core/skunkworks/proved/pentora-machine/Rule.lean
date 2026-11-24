import Pentora
/-! # A rule on six whole numbers that gives exactly the 110 cells

A point is three numbers a + b·φ, so six whole numbers. Write q for twice a cell's position. This file states a test
on the six numbers that uses no table of vertices or cubes, and proves that a point passes it exactly when it is one
of the 110 outer cells of the figure. The proof is a finite check in the kernel plus a bound that makes the check
complete for ALL whole numbers. Core Lean 4.19.0, nothing beyond `Pentora.lean`. -/
namespace Pentora

/-- y is φ·x and z is φ·y, both up to even numbers. (φ·(a + b·φ) = b + (a + b)·φ.) -/
def inL (q : Pt) : Bool :=
  (q.2.1.a - q.1.b) % 2 == 0 && (q.2.1.b - q.1.a - q.1.b) % 2 == 0 &&
  (q.2.2.a - q.2.1.b) % 2 == 0 && (q.2.2.b - q.2.1.a - q.2.1.b) % 2 == 0

def allEven (q : Pt) : Bool :=
  q.1.a % 2 == 0 && q.1.b % 2 == 0 && q.2.1.a % 2 == 0 && q.2.1.b % 2 == 0 && q.2.2.a % 2 == 0 && q.2.2.b % 2 == 0

/-- q/2 - (1, 1, 1), for a point with even numbers. -/
def halfLessOne (q : Pt) : Pt :=
  (⟨q.1.a / 2 - 1, q.1.b / 2⟩, ⟨q.2.1.a / 2 - 1, q.2.1.b / 2⟩, ⟨q.2.2.a / 2 - 1, q.2.2.b / 2⟩)

/-- THE RULE. Squared length 4 or 8 and in the lattice; or squared length 12, even, and in the shifted lattice. -/
def rule (q : Pt) : Bool :=
  if norm2 q == ⟨4, 0⟩ || norm2 q == ⟨8, 0⟩ then inL q
  else if norm2 q == ⟨12, 0⟩ then allEven q && inL (halfLessOne q)
  else false

/-- Half of a point (used on the cell lists of `Pentora.lean`, which are kept at four times size). -/
def halfPt (p : Pt) : Pt := (⟨p.1.a / 2, p.1.b / 2⟩, ⟨p.2.1.a / 2, p.2.1.b / 2⟩, ⟨p.2.2.a / 2, p.2.2.b / 2⟩)
/-- The 110 outer cells, each as twice its position. -/
def cells2 : List Pt := (allPrivate ++ allCorners).map halfPt

/-- The halving loses nothing, the 110 are different points, and every one passes the rule. -/
theorem cells_pass_the_rule :
    ((allPrivate ++ allCorners).all fun p => allEven p) = true ∧ cells2.eraseDups.length = 110 ∧
    cells2.all rule = true := by decide +kernel

/-- The same 110 points written out, so that the finite check below does not rebuild the figure each time. -/
def cellsLit : List Pt := [
  (⟨2, 0⟩, ⟨2, 0⟩, ⟨0, 0⟩), (⟨2, 0⟩, ⟨0, 0⟩, ⟨2, 0⟩), (⟨0, 0⟩, ⟨2, 0⟩, ⟨2, 0⟩), (⟨2, 0⟩, ⟨0, 0⟩, ⟨-2, 0⟩),
  (⟨0, 0⟩, ⟨2, 0⟩, ⟨-2, 0⟩), (⟨2, 0⟩, ⟨-2, 0⟩, ⟨0, 0⟩), (⟨0, 0⟩, ⟨-2, 0⟩, ⟨2, 0⟩), (⟨0, 0⟩, ⟨-2, 0⟩, ⟨-2, 0⟩),
  (⟨-2, 0⟩, ⟨2, 0⟩, ⟨0, 0⟩), (⟨-2, 0⟩, ⟨0, 0⟩, ⟨2, 0⟩), (⟨-2, 0⟩, ⟨0, 0⟩, ⟨-2, 0⟩), (⟨-2, 0⟩, ⟨-2, 0⟩, ⟨0, 0⟩),
  (⟨2, 0⟩, ⟨0, 0⟩, ⟨0, 0⟩), (⟨0, 0⟩, ⟨2, 0⟩, ⟨0, 0⟩), (⟨0, 0⟩, ⟨0, 0⟩, ⟨2, 0⟩), (⟨0, 0⟩, ⟨0, 0⟩, ⟨-2, 0⟩),
  (⟨0, 0⟩, ⟨-2, 0⟩, ⟨0, 0⟩), (⟨-2, 0⟩, ⟨0, 0⟩, ⟨0, 0⟩), (⟨1, 0⟩, ⟨2, -1⟩, ⟨1, 1⟩), (⟨1, 1⟩, ⟨1, 0⟩, ⟨2, -1⟩),
  (⟨2, -1⟩, ⟨1, 1⟩, ⟨1, 0⟩), (⟨-1, 0⟩, ⟨-2, 1⟩, ⟨-1, -1⟩), (⟨-1, -1⟩, ⟨-1, 0⟩, ⟨-2, 1⟩), (⟨-2, 1⟩, ⟨-1, -1⟩, ⟨-1, 0⟩),
  (⟨0, 1⟩, ⟨-1, 1⟩, ⟨1, -2⟩), (⟨1, -1⟩, ⟨-1, 2⟩, ⟨0, -1⟩), (⟨0, -1⟩, ⟨1, -1⟩, ⟨-1, 2⟩), (⟨1, -2⟩, ⟨0, 1⟩, ⟨-1, 1⟩),
  (⟨-1, 1⟩, ⟨1, -2⟩, ⟨0, 1⟩), (⟨-1, 2⟩, ⟨0, -1⟩, ⟨1, -1⟩), (⟨1, 0⟩, ⟨0, 1⟩, ⟨1, -1⟩), (⟨1, -1⟩, ⟨1, 0⟩, ⟨0, 1⟩),
  (⟨0, 1⟩, ⟨1, -1⟩, ⟨1, 0⟩), (⟨-1, 0⟩, ⟨0, -1⟩, ⟨-1, 1⟩), (⟨-1, 1⟩, ⟨-1, 0⟩, ⟨0, -1⟩), (⟨0, -1⟩, ⟨-1, 1⟩, ⟨-1, 0⟩),
  (⟨1, 1⟩, ⟨1, 0⟩, ⟨-2, 1⟩), (⟨2, -1⟩, ⟨1, 1⟩, ⟨-1, 0⟩), (⟨1, 0⟩, ⟨2, -1⟩, ⟨-1, -1⟩), (⟨-1, 0⟩, ⟨-2, 1⟩, ⟨1, 1⟩),
  (⟨-2, 1⟩, ⟨-1, -1⟩, ⟨1, 0⟩), (⟨-1, -1⟩, ⟨-1, 0⟩, ⟨2, -1⟩), (⟨0, 1⟩, ⟨-1, 1⟩, ⟨-1, 2⟩), (⟨1, -1⟩, ⟨-1, 2⟩, ⟨0, 1⟩),
  (⟨-1, 2⟩, ⟨0, -1⟩, ⟨-1, 1⟩), (⟨-1, 1⟩, ⟨1, -2⟩, ⟨0, -1⟩), (⟨1, -2⟩, ⟨0, 1⟩, ⟨1, -1⟩), (⟨0, -1⟩, ⟨1, -1⟩, ⟨1, -2⟩),
  (⟨1, 0⟩, ⟨0, 1⟩, ⟨-1, 1⟩), (⟨0, 1⟩, ⟨1, -1⟩, ⟨-1, 0⟩), (⟨1, -1⟩, ⟨1, 0⟩, ⟨0, -1⟩), (⟨-1, 1⟩, ⟨-1, 0⟩, ⟨0, 1⟩),
  (⟨0, -1⟩, ⟨-1, 1⟩, ⟨1, 0⟩), (⟨-1, 0⟩, ⟨0, -1⟩, ⟨1, -1⟩), (⟨1, 0⟩, ⟨-2, 1⟩, ⟨1, 1⟩), (⟨1, 1⟩, ⟨-1, 0⟩, ⟨2, -1⟩),
  (⟨2, -1⟩, ⟨-1, -1⟩, ⟨1, 0⟩), (⟨-2, 1⟩, ⟨1, 1⟩, ⟨-1, 0⟩), (⟨-1, -1⟩, ⟨1, 0⟩, ⟨-2, 1⟩), (⟨-1, 0⟩, ⟨2, -1⟩, ⟨-1, -1⟩),
  (⟨-1, 1⟩, ⟨-1, 2⟩, ⟨0, 1⟩), (⟨0, -1⟩, ⟨-1, 1⟩, ⟨-1, 2⟩), (⟨-1, 2⟩, ⟨0, 1⟩, ⟨1, -1⟩), (⟨1, -2⟩, ⟨0, -1⟩, ⟨-1, 1⟩),
  (⟨0, 1⟩, ⟨1, -1⟩, ⟨1, -2⟩), (⟨1, -1⟩, ⟨1, -2⟩, ⟨0, -1⟩), (⟨0, 1⟩, ⟨-1, 1⟩, ⟨1, 0⟩), (⟨1, -1⟩, ⟨-1, 0⟩, ⟨0, 1⟩),
  (⟨1, 0⟩, ⟨0, -1⟩, ⟨1, -1⟩), (⟨-1, 0⟩, ⟨0, 1⟩, ⟨-1, 1⟩), (⟨-1, 1⟩, ⟨1, 0⟩, ⟨0, -1⟩), (⟨0, -1⟩, ⟨1, -1⟩, ⟨-1, 0⟩),
  (⟨1, 1⟩, ⟨-1, 0⟩, ⟨-2, 1⟩), (⟨1, 0⟩, ⟨-2, 1⟩, ⟨-1, -1⟩), (⟨2, -1⟩, ⟨-1, -1⟩, ⟨-1, 0⟩), (⟨-2, 1⟩, ⟨1, 1⟩, ⟨1, 0⟩),
  (⟨-1, 0⟩, ⟨2, -1⟩, ⟨1, 1⟩), (⟨-1, -1⟩, ⟨1, 0⟩, ⟨2, -1⟩), (⟨-1, 2⟩, ⟨0, 1⟩, ⟨-1, 1⟩), (⟨0, 1⟩, ⟨1, -1⟩, ⟨-1, 2⟩),
  (⟨-1, 1⟩, ⟨-1, 2⟩, ⟨0, -1⟩), (⟨0, -1⟩, ⟨-1, 1⟩, ⟨1, -2⟩), (⟨1, -1⟩, ⟨1, -2⟩, ⟨0, 1⟩), (⟨1, -2⟩, ⟨0, -1⟩, ⟨1, -1⟩),
  (⟨0, 1⟩, ⟨-1, 1⟩, ⟨-1, 0⟩), (⟨1, 0⟩, ⟨0, -1⟩, ⟨-1, 1⟩), (⟨1, -1⟩, ⟨-1, 0⟩, ⟨0, -1⟩), (⟨-1, 1⟩, ⟨1, 0⟩, ⟨0, 1⟩),
  (⟨-1, 0⟩, ⟨0, 1⟩, ⟨1, -1⟩), (⟨0, -1⟩, ⟨1, -1⟩, ⟨1, 0⟩), (⟨2, 0⟩, ⟨2, 0⟩, ⟨2, 0⟩), (⟨2, 0⟩, ⟨2, 0⟩, ⟨-2, 0⟩),
  (⟨2, 0⟩, ⟨-2, 0⟩, ⟨2, 0⟩), (⟨2, 0⟩, ⟨-2, 0⟩, ⟨-2, 0⟩), (⟨-2, 0⟩, ⟨2, 0⟩, ⟨2, 0⟩), (⟨-2, 0⟩, ⟨2, 0⟩, ⟨-2, 0⟩),
  (⟨-2, 0⟩, ⟨-2, 0⟩, ⟨2, 0⟩), (⟨-2, 0⟩, ⟨-2, 0⟩, ⟨-2, 0⟩), (⟨0, 0⟩, ⟨-2, 2⟩, ⟨0, 2⟩), (⟨0, 2⟩, ⟨0, 0⟩, ⟨-2, 2⟩),
  (⟨-2, 2⟩, ⟨0, 2⟩, ⟨0, 0⟩), (⟨0, 0⟩, ⟨-2, 2⟩, ⟨0, -2⟩), (⟨0, -2⟩, ⟨0, 0⟩, ⟨-2, 2⟩), (⟨-2, 2⟩, ⟨0, -2⟩, ⟨0, 0⟩),
  (⟨0, 0⟩, ⟨2, -2⟩, ⟨0, 2⟩), (⟨0, 2⟩, ⟨0, 0⟩, ⟨2, -2⟩), (⟨2, -2⟩, ⟨0, 2⟩, ⟨0, 0⟩), (⟨0, 0⟩, ⟨2, -2⟩, ⟨0, -2⟩),
  (⟨0, -2⟩, ⟨0, 0⟩, ⟨2, -2⟩), (⟨2, -2⟩, ⟨0, -2⟩, ⟨0, 0⟩)]

theorem cells_lit : cells2 = cellsLit := by decide +kernel

/-- Seven values, skipping those that would take the sum of squares past 12. -/
def all7p (s : Int) (f : Int → Int → Bool) : Bool :=
  (if s + 9 > 12 then true else f (-3) (s + 9)) && (if s + 4 > 12 then true else f (-2) (s + 4)) &&
  (if s + 1 > 12 then true else f (-1) (s + 1)) && f 0 s &&
  (if s + 1 > 12 then true else f 1 (s + 1)) && (if s + 4 > 12 then true else f 2 (s + 4)) &&
  (if s + 9 > 12 then true else f 3 (s + 9))

theorem all7p_spec {s : Int} {f : Int → Int → Bool} (h : all7p s f = true) (x : Int) (lo : -3 ≤ x) (hi : x ≤ 3)
    (fit : s + x * x ≤ 12) : f x (s + x * x) = true := by
  simp only [all7p, Bool.and_eq_true] at h
  have c : x = -3 ∨ x = -2 ∨ x = -1 ∨ x = 0 ∨ x = 1 ∨ x = 2 ∨ x = 3 := by omega
  rcases c with rfl | rfl | rfl | rfl | rfl | rfl | rfl
  · have k := h.1.1.1.1.1.1; rw [if_neg (by omega)] at k; exact k
  · have k := h.1.1.1.1.1.2; rw [if_neg (by omega)] at k; exact k
  · have k := h.1.1.1.1.2; rw [if_neg (by omega)] at k; exact k
  · have k := h.1.1.1.2; simpa using k
  · have k := h.1.1.2; rw [if_neg (by omega)] at k; exact k
  · have k := h.1.2; rw [if_neg (by omega)] at k; exact k
  · have k := h.2; rw [if_neg (by omega)] at k; exact k

/-- THE FINITE CHECK: among all points whose six numbers have squares adding to at most 12, every one that passes
    the rule is one of the 110 listed cells. -/
theorem box_check :
    (all7p 0 fun a1 s1 => all7p s1 fun b1 s2 => all7p s2 fun a2 s3 => all7p s3 fun b2 s4 => all7p s4 fun a3 s5 =>
      all7p s5 fun b3 _ =>
        !rule (⟨a1, b1⟩, ⟨a2, b2⟩, ⟨a3, b3⟩) || cellsLit.contains (⟨a1, b1⟩, ⟨a2, b2⟩, ⟨a3, b3⟩)) = true := by
  decide +kernel

theorem sq_nonneg' (x : Int) : 0 ≤ x * x := by
  rcases Int.le_total 0 x with h | h
  · exact Int.mul_nonneg h h
  · have := Int.mul_nonneg (Int.neg_nonneg_of_nonpos h) (Int.neg_nonneg_of_nonpos h)
    rwa [Int.neg_mul_neg] at this

theorem small_of_sq (x : Int) (h : x * x ≤ 12) : -3 ≤ x ∧ x ≤ 3 := by
  constructor
  · apply Decidable.byContradiction
    intro k
    have k4 : 4 ≤ -x := by omega
    have := Int.mul_le_mul k4 k4 (by decide) (by omega)
    rw [Int.neg_mul_neg] at this
    omega
  · apply Decidable.byContradiction
    intro k
    have k4 : 4 ≤ x := by omega
    have := Int.mul_le_mul k4 k4 (by decide) (by omega)
    omega

/-- The whole part of the squared length is the sum of the six squares. -/
theorem norm2_a (q : Pt) :
    (norm2 q).a = q.1.a * q.1.a + q.1.b * q.1.b + (q.2.1.a * q.2.1.a + q.2.1.b * q.2.1.b) +
      (q.2.2.a * q.2.2.a + q.2.2.b * q.2.2.b) := by
  simp [norm2, Zphi.sq, Zphi.mul, Zphi.add]

/-- A point that passes the rule has squared length at most 12 in its whole part. -/
theorem rule_norm {q : Pt} (h : rule q = true) : (norm2 q).a ≤ 12 := by
  unfold rule at h
  by_cases h1 : (norm2 q == ⟨4, 0⟩ || norm2 q == ⟨8, 0⟩) = true
  · have h1' : norm2 q = ⟨4, 0⟩ ∨ norm2 q = ⟨8, 0⟩ := by simpa using h1
    rcases h1' with e | e <;> rw [e] <;> decide
  · rw [if_neg h1] at h
    by_cases h2 : (norm2 q == ⟨12, 0⟩) = true
    · have e : norm2 q = ⟨12, 0⟩ := by simpa using h2
      rw [e]; decide
    · rw [if_neg h2] at h; cases h

/-- THE RULE GIVES EXACTLY THE FIGURE. For ALL whole numbers: a point passes the rule exactly when it is one of the
    110 outer cells (as twice its position). -/
theorem rule_iff_cell (q : Pt) : rule q = true ↔ q ∈ cells2 := by
  constructor
  · intro h
    have n := rule_norm h
    rw [norm2_a] at n
    have p1 := sq_nonneg' q.1.a; have p2 := sq_nonneg' q.1.b; have p3 := sq_nonneg' q.2.1.a
    have p4 := sq_nonneg' q.2.1.b; have p5 := sq_nonneg' q.2.2.a; have p6 := sq_nonneg' q.2.2.b
    have s1 := small_of_sq q.1.a (by omega); have s2 := small_of_sq q.1.b (by omega)
    have s3 := small_of_sq q.2.1.a (by omega); have s4 := small_of_sq q.2.1.b (by omega)
    have s5 := small_of_sq q.2.2.a (by omega); have s6 := small_of_sq q.2.2.b (by omega)
    have t1 : (0 : Int) + q.1.a * q.1.a ≤ 12 := by omega
    have t2 : 0 + q.1.a * q.1.a + q.1.b * q.1.b ≤ 12 := by omega
    have t3 : 0 + q.1.a * q.1.a + q.1.b * q.1.b + q.2.1.a * q.2.1.a ≤ 12 := by omega
    have t4 : 0 + q.1.a * q.1.a + q.1.b * q.1.b + q.2.1.a * q.2.1.a + q.2.1.b * q.2.1.b ≤ 12 := by omega
    have t5 : 0 + q.1.a * q.1.a + q.1.b * q.1.b + q.2.1.a * q.2.1.a + q.2.1.b * q.2.1.b + q.2.2.a * q.2.2.a ≤ 12 := by omega
    have t6 : 0 + q.1.a * q.1.a + q.1.b * q.1.b + q.2.1.a * q.2.1.a + q.2.1.b * q.2.1.b + q.2.2.a * q.2.2.a +
        q.2.2.b * q.2.2.b ≤ 12 := by omega
    have b := all7p_spec (all7p_spec (all7p_spec (all7p_spec (all7p_spec (all7p_spec box_check
      q.1.a s1.1 s1.2 t1) q.1.b s2.1 s2.2 t2) q.2.1.a s3.1 s3.2 t3) q.2.1.b s4.1 s4.2 t4) q.2.2.a s5.1 s5.2 t5)
      q.2.2.b s6.1 s6.2 t6
    have e : ((⟨q.1.a, q.1.b⟩, ⟨q.2.1.a, q.2.1.b⟩, ⟨q.2.2.a, q.2.2.b⟩) : Pt) = q := rfl
    rw [e, h] at b
    rw [cells_lit]
    simpa using b
  · intro m
    exact (List.all_eq_true.1 cells_pass_the_rule.2.2) q m

end Pentora
