/-! # The Pentora machine

Part 1 checks the listed vertices, five cube distance signatures and sampled cell counts in exact arithmetic.
Among the sampled outer cells, only corners are shared. All five cubes also share the origin. In Part 2 each
organ reports its own outer cells, and the two owners of each corner must agree. Core Lean 4.19.0. -/
namespace Pentora

/-! ## Part 1. The figure, exactly (numbers a + b·φ with whole a, b, where φ² = φ + 1; no decimals anywhere) -/

structure Zphi where
  a : Int
  b : Int
  deriving DecidableEq, Repr

namespace Zphi
def add (x y : Zphi) : Zphi := ⟨x.a + y.a, x.b + y.b⟩
def sub (x y : Zphi) : Zphi := ⟨x.a - y.a, x.b - y.b⟩
def mul (x y : Zphi) : Zphi := ⟨x.a * y.a + x.b * y.b, x.a * y.b + x.b * y.a + x.b * y.b⟩
def scale (k : Int) (x : Zphi) : Zphi := ⟨k * x.a, k * x.b⟩
def sq (x : Zphi) : Zphi := x.mul x
end Zphi

abbrev Pt := Zphi × Zphi × Zphi
def origin : Pt := (⟨0, 0⟩, ⟨0, 0⟩, ⟨0, 0⟩)

/-- The 20 vertices of a dodecahedron: (±1, ±1, ±1) and the turns of (0, ±1/φ, ±φ), with 1/φ = φ - 1. -/
def vertices : List (Zphi × Zphi × Zphi) := [
  (⟨1, 0⟩, ⟨1, 0⟩, ⟨1, 0⟩),
  (⟨1, 0⟩, ⟨1, 0⟩, ⟨-1, 0⟩),
  (⟨1, 0⟩, ⟨-1, 0⟩, ⟨1, 0⟩),
  (⟨1, 0⟩, ⟨-1, 0⟩, ⟨-1, 0⟩),
  (⟨-1, 0⟩, ⟨1, 0⟩, ⟨1, 0⟩),
  (⟨-1, 0⟩, ⟨1, 0⟩, ⟨-1, 0⟩),
  (⟨-1, 0⟩, ⟨-1, 0⟩, ⟨1, 0⟩),
  (⟨-1, 0⟩, ⟨-1, 0⟩, ⟨-1, 0⟩),
  (⟨0, 0⟩, ⟨-1, 1⟩, ⟨0, 1⟩),
  (⟨0, 1⟩, ⟨0, 0⟩, ⟨-1, 1⟩),
  (⟨-1, 1⟩, ⟨0, 1⟩, ⟨0, 0⟩),
  (⟨0, 0⟩, ⟨-1, 1⟩, ⟨0, -1⟩),
  (⟨0, -1⟩, ⟨0, 0⟩, ⟨-1, 1⟩),
  (⟨-1, 1⟩, ⟨0, -1⟩, ⟨0, 0⟩),
  (⟨0, 0⟩, ⟨1, -1⟩, ⟨0, 1⟩),
  (⟨0, 1⟩, ⟨0, 0⟩, ⟨1, -1⟩),
  (⟨1, -1⟩, ⟨0, 1⟩, ⟨0, 0⟩),
  (⟨0, 0⟩, ⟨1, -1⟩, ⟨0, -1⟩),
  (⟨0, -1⟩, ⟨0, 0⟩, ⟨1, -1⟩),
  (⟨1, -1⟩, ⟨0, -1⟩, ⟨0, 0⟩)]

def cubeTable : List (List Nat) := [[0, 1, 2, 3, 4, 5, 6, 7], [0, 7, 11, 12, 13, 14, 15, 16], [1, 6, 8, 9, 13, 16, 17, 18], [2, 5, 8, 10, 12, 15, 17, 19], [3, 4, 9, 10, 11, 14, 18, 19]]

def home1Table : List (Nat × Nat) := [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (0, 6), (0, 7), (2, 2), (2, 3), (3, 3), (1, 2), (1, 3), (1, 4), (1, 5), (1, 6), (1, 7), (2, 6), (2, 7), (3, 7)]
def home2Table : List (Nat × Nat) := [(1, 0), (2, 0), (3, 0), (4, 0), (4, 1), (3, 1), (2, 1), (1, 1), (3, 2), (4, 2), (4, 3), (4, 4), (3, 4), (2, 4), (4, 5), (3, 5), (2, 5), (3, 6), (4, 6), (4, 7)]

def vtx (i : Nat) : Pt := vertices.getD i origin
def cube (c : Nat) : List Nat := cubeTable.getD c []

def dist2 (p q : Pt) : Zphi := ((p.1.sub q.1).sq.add (p.2.1.sub q.2.1).sq).add (p.2.2.sub q.2.2).sq
def norm2 (p : Pt) : Zphi := (p.1.sq.add p.2.1.sq).add p.2.2.sq

/-- Check the cube distance signature on a list of eight vertices. Each sees three others at squared distance 4,
    three at 8 and one at 12. -/
def cubeOk (c : List Nat) : Bool :=
  c.length == 8 && c.all fun v =>
    let ds := (c.filter (· != v)).map fun w => dist2 (vtx v) (vtx w)
    ds.count ⟨4, 0⟩ == 3 && ds.count ⟨8, 0⟩ == 3 && ds.count ⟨12, 0⟩ == 1

theorem twenty_vertices :
    vertices.length = 20 ∧ vertices.eraseDups.length = 20 ∧ (vertices.all fun p => norm2 p == ⟨3, 0⟩) = true := by
  decide +kernel

/-- All five listed vertex sets satisfy the cube distance check. -/
theorem five_cubes : cubeTable.length = 5 ∧ cubeTable.all cubeOk = true := by decide +kernel

/-- Each of the 20 listed corners occurs in exactly two cubes. -/
theorem each_corner_in_two :
    ((List.range 20).all fun v => (cubeTable.filter (·.contains v)).length == 2) = true := by decide +kernel

/-- Every pair of distinct listed cubes shares exactly two corners. -/
theorem each_pair_shares_two :
    ((List.range 5).all fun a => (List.range 5).all fun b =>
      a == b || ((cube a).filter (cube b).contains).length == 2) = true := by decide +kernel

/-! The 27 cells of a cube, at four times their size so that every coordinate stays whole: 8 corners, 12 edge
middles, 6 face centres, 1 centre. -/
def mid (p q : Pt) : Pt := ((p.1.add q.1).scale 2, (p.2.1.add q.2.1).scale 2, (p.2.2.add q.2.2).scale 2)
def corner4 (p : Pt) : Pt := (p.1.scale 4, p.2.1.scale 4, p.2.2.scale 4)
def pairsAt (c : List Nat) (d : Zphi) : List Pt :=
  c.flatMap fun v => (c.filter fun w => decide (v < w) && dist2 (vtx v) (vtx w) == d).map fun w => mid (vtx v) (vtx w)
def edgeCells (c : List Nat) : List Pt := pairsAt c ⟨4, 0⟩
def faceCells (c : List Nat) : List Pt := (pairsAt c ⟨8, 0⟩).eraseDups
def privateCells (c : List Nat) : List Pt := edgeCells c ++ faceCells c
def allPrivate : List Pt := cubeTable.flatMap privateCells
def allCorners : List Pt := vertices.map corner4

/-- For each listed cube, 12 edge midpoints, six face centres and the common origin complete the 27 samples
    together with its eight corners. -/
theorem cube_has_27 :
    (cubeTable.all fun c => (edgeCells c).length == 12 && (faceCells c).length == 6 &&
      ((pairsAt c ⟨12, 0⟩).eraseDups == [origin])) = true := by decide +kernel

/-- Among the 110 sampled outer cells, only corners are shared. The 90 edge and face cells are all distinct and
    disjoint from the 20 listed corners. The shells contain 30, 60 and 20 points at squared radii 16, 32 and 48
    in the scaled coordinates. All five cubes also share the origin. -/
theorem figure_110 :
    allPrivate.length = 90 ∧ (allPrivate ++ allCorners).eraseDups.length = 110 ∧
    (allCorners.all fun p => norm2 p == ⟨48, 0⟩) = true ∧
    (cubeTable.all fun c => (edgeCells c).all fun p => norm2 p == ⟨32, 0⟩) = true ∧
    (cubeTable.all fun c => (faceCells c).all fun p => norm2 p == ⟨16, 0⟩) = true := by decide +kernel

/-! ## Part 2. The machine: five organs, one cube each, agreement at the shared corners -/

/-- One cell of a report: a check that failed, is not known, or passed. -/
inductive Trit | fail | unknown | pass
  deriving DecidableEq, Repr

def fins : (n : Nat) → List (Fin n)
  | 0 => []
  | n + 1 => (0 : Fin (n + 1)) :: (fins n).map Fin.succ

theorem mem_fins : ∀ {n : Nat} (i : Fin n), i ∈ fins n
  | _ + 1, ⟨0, _⟩ => List.mem_cons_self ..
  | _ + 1, ⟨k + 1, h⟩ =>
    List.mem_cons_of_mem _ (List.mem_map.2 ⟨⟨k, Nat.lt_of_succ_lt_succ h⟩, mem_fins _, rfl⟩)

theorem length_fins : ∀ n : Nat, (fins n).length = n
  | 0 => rfl
  | n + 1 => by simp [fins, length_fins n]

/-- Corner number j of cube c is vertex `slot c j` of the figure. -/
def slot (c : Fin 5) (j : Fin 8) : Fin 20 := ⟨(cube c.val).getD j.val 0 % 20, Nat.mod_lt _ (by decide)⟩
/-- The two places a vertex appears: (cube, corner number), once in each of its two cubes. -/
def home1 (v : Fin 20) : Fin 5 × Fin 8 :=
  (⟨(home1Table.getD v.val (0, 0)).1 % 5, Nat.mod_lt _ (by decide)⟩, ⟨(home1Table.getD v.val (0, 0)).2 % 8, Nat.mod_lt _ (by decide)⟩)
def home2 (v : Fin 20) : Fin 5 × Fin 8 :=
  (⟨(home2Table.getD v.val (0, 0)).1 % 5, Nat.mod_lt _ (by decide)⟩, ⟨(home2Table.getD v.val (0, 0)).2 % 8, Nat.mod_lt _ (by decide)⟩)

theorem homes : ∀ v : Fin 20,
    slot (home1 v).1 (home1 v).2 = v ∧ slot (home2 v).1 (home2 v).2 = v ∧ (home1 v).1 ≠ (home2 v).1 := by
  decide +kernel

theorem slots : ∀ (c : Fin 5) (j : Fin 8), home1 (slot c j) = (c, j) ∨ home2 (slot c j) = (c, j) := by
  decide +kernel

/-- TWO WITNESSES FOR EVERY PAIR. Any two different organs share exactly two corners. -/
theorem two_witnesses : ∀ a b : Fin 5, a ≠ b →
    ((fins 20).filter fun v => ((home1 v).1 = a ∧ (home2 v).1 = b) ∨ ((home1 v).1 = b ∧ (home2 v).1 = a)).length = 2 := by
  decide +kernel

/-- One organ reports 18 numbered private slots and eight corners. The model leaves individual private slots
    unassigned to geometric coordinates. -/
structure Report where
  priv : Fin 18 → Trit
  corn : Fin 8 → Trit

/-- The whole body: 90 private cells and the 20 shared corners. -/
structure Body where
  priv : Fin 5 → Fin 18 → Trit
  corn : Fin 20 → Trit

theorem Report.ext' {r s : Report} (p : r.priv = s.priv) (q : r.corn = s.corn) : r = s := by
  cases r; cases s; cases p; cases q; rfl
theorem Body.ext' {g h : Body} (p : g.priv = h.priv) (q : g.corn = h.corn) : g = h := by
  cases g; cases h; cases p; cases q; rfl

/-- What organ c sees of a body. -/
def view (g : Body) (c : Fin 5) : Report := ⟨g.priv c, fun j => g.corn (slot c j)⟩

/-- A corner's value as told by the first, and by the second, of the two organs that share it. -/
def at1 (R : Fin 5 → Report) (v : Fin 20) : Trit := (R (home1 v).1).corn (home1 v).2
def at2 (R : Fin 5 → Report) (v : Fin 20) : Trit := (R (home2 v).1).corn (home2 v).2

/-- Five reports agree when every shared corner is told the same by both of its organs. -/
def Compatible (R : Fin 5 → Report) : Prop := ∀ v, at1 R v = at2 R v

def glue (R : Fin 5 → Report) : Body := ⟨fun c => (R c).priv, at1 R⟩

theorem at1_view (g : Body) (v : Fin 20) : at1 (view g) v = g.corn v := by
  show g.corn (slot (home1 v).1 (home1 v).2) = g.corn v
  rw [(homes v).1]
theorem at2_view (g : Body) (v : Fin 20) : at2 (view g) v = g.corn v := by
  show g.corn (slot (home2 v).1 (home2 v).2) = g.corn v
  rw [(homes v).2.1]

/-- The five views of one body always agree. -/
theorem views_compatible (g : Body) : Compatible (view g) := fun v => by rw [at1_view, at2_view]

/-- GLUING. Five reports that agree at the shared corners are the five views of one body. -/
theorem view_glue (R : Fin 5 → Report) (h : Compatible R) (c : Fin 5) : view (glue R) c = R c := by
  apply Report.ext'
  · rfl
  · funext j
    show at1 R (slot c j) = (R c).corn j
    rcases slots c j with e | e
    · unfold at1; rw [e]
    · rw [h (slot c j)]; unfold at2; rw [e]

/-- ONLY ONE. A body is fixed by its five views: no second body gives the same reports. -/
theorem glue_unique (R : Fin 5 → Report) (g : Body) (h : ∀ c, view g c = R c) : g = glue R := by
  apply Body.ext'
  · funext c; exact congrArg Report.priv (h c)
  · funext v
    show g.corn v = (R (home1 v).1).corn (home1 v).2
    rw [← h (home1 v).1]
    show g.corn v = g.corn (slot (home1 v).1 (home1 v).2)
    rw [(homes v).1]

/-- Agreement is equivalent to the existence of a body with these five views. `glue_unique` supplies uniqueness. -/
theorem gluing (R : Fin 5 → Report) : Compatible R ↔ ∃ g, ∀ c, view g c = R c := by
  constructor
  · intro h; exact ⟨glue R, view_glue R h⟩
  · intro ⟨g, h⟩
    have e : R = view g := funext fun c => (h c).symm
    rw [e]; exact views_compatible g

/-! ### Faults: who can be caught, by whom, and what cannot be seen -/

/-- A false corner from the first owner disagrees with the second owner's truthful report. -/
theorem corner_lie_caught (g : Body) (R : Fin 5 → Report) (v : Fin 20)
    (lie : at1 R v ≠ g.corn v) (honest : R (home2 v).1 = view g (home2 v).1) : at1 R v ≠ at2 R v := by
  have e : at2 R v = g.corn v := by
    show (R (home2 v).1).corn (home2 v).2 = g.corn v
    rw [honest]; exact at2_view g v
  rw [e]; exact lie

/-- The same disagreement occurs when the second owner misreports and the first reports truthfully. -/
theorem corner_lie_caught' (g : Body) (R : Fin 5 → Report) (v : Fin 20)
    (lie : at2 R v ≠ g.corn v) (honest : R (home1 v).1 = view g (home1 v).1) : at1 R v ≠ at2 R v := by
  have e : at1 R v = g.corn v := by
    show (R (home1 v).1).corn (home1 v).2 = g.corn v
    rw [honest]; exact at1_view g v
  rw [e]; exact fun k => lie k.symm

/-- With four truthful reports the faulty organ owns every disagreement. When one corner is disputed, both
    owners are suspects. -/
theorem seam_names_liar (g : Body) (R : Fin 5 → Report) (x : Fin 5)
    (honest : ∀ c, c ≠ x → R c = view g c) (v : Fin 20) (seam : at1 R v ≠ at2 R v) :
    (home1 v).1 = x ∨ (home2 v).1 = x := by
  by_cases h1 : (home1 v).1 = x
  · exact .inl h1
  · by_cases h2 : (home2 v).1 = x
    · exact .inr h2
    · exfalso; apply seam
      have e1 : at1 R v = g.corn v := by
        show (R (home1 v).1).corn (home1 v).2 = g.corn v
        rw [honest _ h1]; exact at1_view g v
      have e2 : at2 R v = g.corn v := by
        show (R (home2 v).1).corn (home2 v).2 = g.corn v
        rw [honest _ h2]; exact at2_view g v
      rw [e1, e2]

/-- Agreement depends only on the corners. Changing a private cell in otherwise agreeing reports leaves no
    disagreements and therefore no suspects. -/
theorem private_cells_unwitnessed (R R' : Fin 5 → Report) (same : ∀ c, (R c).corn = (R' c).corn) :
    Compatible R ↔ Compatible R' := by
  have e1 : ∀ v, at1 R v = at1 R' v := fun v => congrFun (same _) _
  have e2 : ∀ v, at2 R v = at2 R' v := fun v => congrFun (same _) _
  constructor
  · intro h v; rw [← e1, ← e2]; exact h v
  · intro h v; rw [e1, e2]; exact h v

/-! ### The verdict, as a function a machine can run -/

/-- The corners where the two owners disagree. -/
def seams (R : Fin 5 → Report) : List (Fin 20) := (fins 20).filter fun v => at1 R v != at2 R v

def owns (c : Fin 5) (v : Fin 20) : Bool := (home1 v).1 == c || (home2 v).1 == c

/-- The organs that own every disagreeing corner (none when there is no disagreement). -/
def suspects (R : Fin 5 → Report) : List (Fin 5) :=
  if (seams R).isEmpty then [] else (fins 5).filter fun c => (seams R).all (owns c)

theorem mem_seams {R : Fin 5 → Report} {v : Fin 20} : v ∈ seams R ↔ at1 R v ≠ at2 R v := by
  simp [seams, mem_fins]

/-- NO DISAGREEMENT FOUND means the reports agree, and the other way round. -/
theorem seams_nil_iff (R : Fin 5 → Report) : seams R = [] ↔ Compatible R := by
  constructor
  · intro h v
    apply Decidable.byContradiction
    intro k
    have m : v ∈ seams R := mem_seams.2 k
    rw [h] at m; cases m
  · intro h
    apply List.eq_nil_iff_forall_not_mem.2
    intro v m; exact (mem_seams.1 m) (h v)

/-- If every organ but x reports truthfully and at least one corner disagrees, x is a suspect. -/
theorem liar_among_suspects (g : Body) (R : Fin 5 → Report) (x : Fin 5)
    (honest : ∀ c, c ≠ x → R c = view g c) (some : seams R ≠ []) : x ∈ suspects R := by
  have ne : (seams R).isEmpty = false := by
    cases h : seams R with
    | nil => exact absurd h some
    | cons _ _ => rfl
  unfold suspects; rw [ne]
  simp only [Bool.false_eq_true, if_false, List.mem_filter, List.all_eq_true]
  refine ⟨mem_fins x, fun v m => ?_⟩
  rcases seam_names_liar g R x honest v (mem_seams.1 m) with e | e <;> simp [owns, e]

/-- A SUSPECT OWNS EVERY DISAGREEING CORNER, so the suspects are at most the two owners of any one of them. -/
theorem suspect_owns (R : Fin 5 → Report) (c : Fin 5) (v : Fin 20) (s : c ∈ suspects R) (m : v ∈ seams R) :
    owns c v = true := by
  unfold suspects at s
  cases h : (seams R).isEmpty with
  | true => rw [h] at s; cases s
  | false =>
    rw [h] at s
    simp only [Bool.false_eq_true, if_false, List.mem_filter, List.all_eq_true] at s
    exact s.2 v m

/-- Every suspect equals x under the common-owner premise. This conclusion holds for an empty suspect list,
    and the premise holds vacuously for disjoint owner pairs. With four truthful organs and disagreements involving
    two different neighbours, `liar_among_suspects` and `convicted` together identify the faulty organ. -/
theorem convicted (R : Fin 5 → Report) (x : Fin 5) (v w : Fin 20) (mv : v ∈ seams R) (mw : w ∈ seams R)
    (only : ∀ c, owns c v = true → owns c w = true → c = x) : ∀ c, c ∈ suspects R → c = x :=
  fun c s => only c (suspect_owns R c v s mv) (suspect_owns R c w s mw)

/-! ### The three tallies form a point in a triangle and sum to 26 for each report -/

def tally (t : Trit) : List Trit → Nat
  | [] => 0
  | x :: xs => (if x = t then 1 else 0) + tally t xs

/-- The passed, unknown and failed tallies sum to the length of the list. -/
theorem triangle (l : List Trit) : tally .pass l + tally .unknown l + tally .fail l = l.length := by
  induction l with
  | nil => rfl
  | cons x xs ih => cases x <;> simp [tally] <;> omega

def cellsOf (r : Report) : List Trit := (fins 18).map r.priv ++ (fins 8).map r.corn

theorem organ_triangle (r : Report) :
    tally .pass (cellsOf r) + tally .unknown (cellsOf r) + tally .fail (cellsOf r) = 26 := by
  rw [triangle]; simp [cellsOf, length_fins]

theorem tally_pos (t : Trit) (l : List Trit) : 0 < tally t l ↔ t ∈ l := by
  induction l with
  | nil => simp [tally]
  | cons x xs ih =>
    by_cases e : x = t
    · subst e; simp only [tally, if_true, List.mem_cons, true_or, iff_true]; omega
    · have e' : ¬ t = x := fun k => e k.symm
      simp [tally, e, e', ih]

/-- 0 = every check passed, 1 = nothing failed but something is unknown, 2 = something failed. -/
def health (l : List Trit) : Nat := if 0 < tally .fail l then 2 else if 0 < tally .unknown l then 1 else 0

/-- HEALTH 0 MEANS EVERY CELL PASSED. -/
theorem health_zero_iff (l : List Trit) : health l = 0 ↔ ∀ x, x ∈ l → x = .pass := by
  unfold health
  constructor
  · intro h x m
    by_cases f : 0 < tally .fail l
    · simp [f] at h
    · by_cases u : 0 < tally .unknown l
      · simp [f, u] at h
      · cases x with
        | fail => exact absurd ((tally_pos _ _).2 m) f
        | unknown => exact absurd ((tally_pos _ _).2 m) u
        | pass => rfl
  · intro h
    have f : ¬ 0 < tally .fail l := fun k => by have := h _ ((tally_pos _ _).1 k); cases this
    have u : ¬ 0 < tally .unknown l := fun k => by have := h _ ((tally_pos _ _).1 k); cases this
    simp [f, u]

/-- HEALTH 2 MEANS SOME CELL FAILED. -/
theorem health_two_iff (l : List Trit) : health l = 2 ↔ Trit.fail ∈ l := by
  unfold health
  by_cases f : 0 < tally .fail l
  · simp [f, (tally_pos _ _).1 f]
  · have nm : ¬ Trit.fail ∈ l := fun m => f ((tally_pos _ _).2 m)
    by_cases u : 0 < tally .unknown l <;> simp [f, u, nm]

/-! ### The whole body as one number: the address is the state -/

def Trit.code : Trit → Nat
  | .fail => 0 | .unknown => 1 | .pass => 2
def Trit.ofCode (n : Nat) : Trit := if n % 3 = 0 then .fail else if n % 3 = 1 then .unknown else .pass

def rank : List Trit → Nat
  | [] => 0
  | t :: ts => t.code + 3 * rank ts
def unrank : Nat → Nat → List Trit
  | 0, _ => []
  | k + 1, n => Trit.ofCode n :: unrank k (n / 3)

theorem code_lt (t : Trit) : t.code < 3 := by cases t <;> decide
theorem ofCode_code (t : Trit) (r : Nat) : Trit.ofCode (t.code + 3 * r) = t := by
  cases t <;> simp [Trit.ofCode, Trit.code, Nat.add_mul_mod_self_left]

theorem unrank_rank (s : List Trit) : unrank s.length (rank s) = s := by
  induction s with
  | nil => rfl
  | cons t ts ih =>
    have hdiv : (t.code + 3 * rank ts) / 3 = rank ts := by have := code_lt t; omega
    simp [rank, unrank, ofCode_code, hdiv, ih]

theorem rank_lt (s : List Trit) : rank s < 3 ^ s.length := by
  induction s with
  | nil => simp [rank]
  | cons t ts ih =>
    have := code_lt t
    simp only [rank, List.length_cons, Nat.pow_succ]
    omega

/-- Cell i of the body: the 90 private cells, cube by cube, then the 20 corners. -/
def cell (g : Body) (i : Fin 110) : Trit :=
  if h : i.val < 90 then g.priv ⟨i.val / 18, by omega⟩ ⟨i.val % 18, Nat.mod_lt _ (by decide)⟩
  else g.corn ⟨i.val - 90, by omega⟩

def cells (g : Body) : List Trit := (fins 110).map (cell g)
/-- The address of a body: its 110 cells read as one number in base three. -/
def address (g : Body) : Nat := rank (cells g)

theorem cells_length (g : Body) : (cells g).length = 110 := by simp [cells, length_fins]

/-- These bounds put the 110-trit address space in 22 bytes and rule out 21 bytes. -/
theorem fits_22_bytes : 3 ^ 110 < 2 ^ 176 ∧ 2 ^ 168 < 3 ^ 110 := by decide

theorem address_lt (g : Body) : address g < 2 ^ 176 := by
  have h := rank_lt (cells g)
  rw [cells_length] at h
  exact Nat.lt_trans h fits_22_bytes.1

/-- The address encodes all 110 trits injectively. The largest address, 3^110 - 1, needs 175 bits. Each organ
    can compare its own 26 trits with its view of a supplied body. -/
theorem address_injective {g g' : Body} (h : address g = address g') : g = g' := by
  have hc : cells g = cells g' := by
    have a := unrank_rank (cells g); have b := unrank_rank (cells g')
    rw [cells_length] at a b
    unfold address at h
    rw [← a, ← b, h]
  have hp : ∀ i, cell g i = cell g' i := fun i => (List.map_inj_left.1 hc) i (mem_fins i)
  apply Body.ext'
  · funext c k
    have hc5 := c.isLt; have hk := k.isLt
    have hlt : c.val * 18 + k.val < 90 := by omega
    have e := hp ⟨c.val * 18 + k.val, by omega⟩
    unfold cell at e
    rw [dif_pos hlt, dif_pos hlt] at e
    have ec : (⟨(c.val * 18 + k.val) / 18, by omega⟩ : Fin 5) = c := Fin.ext (by show (c.val * 18 + k.val) / 18 = c.val; omega)
    have ek : (⟨(c.val * 18 + k.val) % 18, Nat.mod_lt _ (by decide)⟩ : Fin 18) = k := Fin.ext (by show (c.val * 18 + k.val) % 18 = k.val; omega)
    rw [ec, ek] at e
    exact e
  · funext v
    have hv := v.isLt
    have hge : ¬ (90 + v.val < 90) := by omega
    have e := hp ⟨90 + v.val, by omega⟩
    unfold cell at e
    rw [dif_neg hge, dif_neg hge] at e
    have ev : (⟨90 + v.val - 90, by omega⟩ : Fin 20) = v := Fin.ext (by show 90 + v.val - 90 = v.val; omega)
    rw [ev] at e
    exact e

/-- Address of the glued body. With agreeing reports each of its views matches the corresponding report. -/
def addressOf (R : Fin 5 → Report) : Nat := address (glue R)

/-! ## Part 3. Three levels of knowing: one owner, two owners, all five

A private cell is seen by one organ. Two distinct owners per corner give four-organ coverage. Exactly two corners
per pair explain why any three miss two. These laws are stated for this layout. -/

theorem code_ofCode (n : Nat) : (Trit.ofCode n).code = n % 3 := by
  unfold Trit.ofCode
  by_cases h0 : n % 3 = 0
  · simp [h0, Trit.code]
  · by_cases h1 : n % 3 = 1
    · simp [h1, Trit.code]
    · have : n % 3 = 2 := by omega
      simp [this, Trit.code]

theorem cell_priv (g : Body) (c : Fin 5) (k : Fin 18) :
    cell g ⟨c.val * 18 + k.val, by have := c.isLt; have := k.isLt; omega⟩ = g.priv c k := by
  have hc5 := c.isLt; have hk := k.isLt
  have hlt : c.val * 18 + k.val < 90 := by omega
  unfold cell
  rw [dif_pos hlt]
  have ec : (⟨(c.val * 18 + k.val) / 18, by omega⟩ : Fin 5) = c := Fin.ext (by show (c.val * 18 + k.val) / 18 = c.val; omega)
  have ek : (⟨(c.val * 18 + k.val) % 18, Nat.mod_lt _ (by decide)⟩ : Fin 18) = k := Fin.ext (by show (c.val * 18 + k.val) % 18 = k.val; omega)
  rw [ec, ek]

theorem cell_corn (g : Body) (v : Fin 20) : cell g ⟨90 + v.val, by have := v.isLt; omega⟩ = g.corn v := by
  have hv := v.isLt
  have hge : ¬ (90 + v.val < 90) := by omega
  unfold cell
  rw [dif_neg hge]
  have ev : (⟨90 + v.val - 90, by omega⟩ : Fin 20) = v := Fin.ext (by show 90 + v.val - 90 = v.val; omega)
  rw [ev]

/-- Every trit value occurring in a local view occurs in the body's list of trits. -/
theorem view_cell_in_body (g : Body) (c : Fin 5) (t : Trit) (m : t ∈ cellsOf (view g c)) : t ∈ cells g := by
  unfold cellsOf at m
  rcases List.mem_append.1 m with m | m
  · obtain ⟨k, _, rfl⟩ := List.mem_map.1 m
    exact List.mem_map.2 ⟨_, mem_fins _, cell_priv g c k⟩
  · obtain ⟨j, _, rfl⟩ := List.mem_map.1 m
    exact List.mem_map.2 ⟨_, mem_fins _, cell_corn g (slot c j)⟩

/-- Centre health is computed over the body's 110 cells. It is 0 when all passed, 1 for unknown with no failure,
    and 2 for any failure. -/
def centre (g : Body) : Nat := health (cells g)

/-- THE CENTRE IS CLEAR exactly when every one of the 110 cells passed. -/
theorem centre_zero_iff (g : Body) : centre g = 0 ↔ ∀ i, cell g i = .pass := by
  unfold centre
  rw [health_zero_iff]
  constructor
  · intro h i; exact h _ (List.mem_map.2 ⟨i, mem_fins i, rfl⟩)
  · intro h x m; obtain ⟨i, _, rfl⟩ := List.mem_map.1 m; exact h i

/-- If an organ's view of the body contains a failed trit, the body's centre health is 2. -/
theorem local_fail_reaches_centre (g : Body) (c : Fin 5) (h : health (cellsOf (view g c)) = 2) : centre g = 2 :=
  (health_two_iff _).2 (view_cell_in_body g c _ ((health_two_iff _).1 h))

/-- Equal addresses give equal centre health by address injectivity. -/
theorem centre_of_address {g g' : Body} (h : address g = address g') : centre g = centre g' := by
  rw [address_injective h]

/-- For distinct x and y, select the lower of the two corners they own together. -/
def blindOf (x y : Fin 5) : Fin 20 :=
  ((fins 20).filter fun v => ((home1 v).1 = x ∧ (home2 v).1 = y) ∨ ((home1 v).1 = y ∧ (home2 v).1 = x)).headD 0

/-- For two distinct omitted organs, the selected corner is owned by that pair. -/
theorem blind_corner : ∀ x y : Fin 5, x ≠ y →
    ((home1 (blindOf x y)).1 = x ∧ (home2 (blindOf x y)).1 = y) ∨
    ((home1 (blindOf x y)).1 = y ∧ (home2 (blindOf x y)).1 = x) := by decide +kernel

/-- Equal views at four organs determine the same 20 global corners, including the fifth organ's eight. -/
theorem four_see_all (g g' : Body) (x : Fin 5) (h : ∀ c, c ≠ x → view g c = view g' c) : g.corn = g'.corn := by
  funext v
  have hv := homes v
  by_cases h1 : (home1 v).1 = x
  · have h2 : (home2 v).1 ≠ x := fun k => hv.2.2 (h1.trans k.symm)
    have e : (view g (home2 v).1).corn (home2 v).2 = (view g' (home2 v).1).corn (home2 v).2 := by rw [h _ h2]
    change g.corn (slot (home2 v).1 (home2 v).2) = g'.corn (slot (home2 v).1 (home2 v).2) at e
    rw [hv.2.1] at e; exact e
  · have e : (view g (home1 v).1).corn (home1 v).2 = (view g' (home1 v).1).corn (home1 v).2 := by rw [h _ h1]
    change g.corn (slot (home1 v).1 (home1 v).2) = g'.corn (slot (home1 v).1 (home1 v).2) at e
    rw [hv.1] at e; exact e

/-- Given the excluded organ's index x, read each corner from an owner other than x. -/
def heal (R : Fin 5 → Report) (x : Fin 5) : Fin 20 → Trit :=
  fun v => if (home1 v).1 = x then at2 R v else at1 R v

/-- Given x and reports for all five organs, `heal` reads all 20 global corners from the other four. With
    those four truthful, these include the eight true corners of x. Its 18 private cells remain unknown.
    The Wasm call requires a valid fifth report as filler and writes nothing. -/
theorem heal_true (g : Body) (R : Fin 5 → Report) (x : Fin 5) (honest : ∀ c, c ≠ x → R c = view g c) :
    heal R x = g.corn := by
  funext v
  have hv := homes v
  unfold heal
  by_cases h1 : (home1 v).1 = x
  · rw [if_pos h1]
    have h2 : (home2 v).1 ≠ x := fun k => hv.2.2 (h1.trans k.symm)
    show (R (home2 v).1).corn (home2 v).2 = g.corn v
    rw [honest _ h2]; exact at2_view g v
  · rw [if_neg h1]
    show (R (home1 v).1).corn (home1 v).2 = g.corn v
    rw [honest _ h1]; exact at1_view g v

/-! ### The seal: one value spread over the 20 corners -/

def upd (f : Fin 20 → Trit) (v : Fin 20) (t : Trit) : Fin 20 → Trit := fun u => if u = v then t else f u
def sumC (f : Fin 20 → Trit) : List (Fin 20) → Nat
  | [] => 0
  | u :: us => (f u).code + sumC f us
def cnt (v : Fin 20) : List (Fin 20) → Nat
  | [] => 0
  | u :: us => (if u = v then 1 else 0) + cnt v us

theorem sumC_upd (f : Fin 20 → Trit) (v : Fin 20) (t : Trit) :
    ∀ l, sumC (upd f v t) l + cnt v l * (f v).code = sumC f l + cnt v l * t.code
  | [] => by simp [sumC, cnt]
  | u :: us => by
    have ih := sumC_upd f v t us
    by_cases e : u = v
    · subst e
      simp only [sumC, cnt, upd, if_true]
      rw [Nat.add_mul, Nat.add_mul, Nat.one_mul, Nat.one_mul]
      omega
    · simp only [sumC, cnt, upd, if_neg e, Nat.zero_add]
      omega

theorem cnt_fins : ∀ v : Fin 20, cnt v (fins 20) = 1 := by decide +kernel

/-- The seal trit is the sum of the 20 corner codes modulo three. Do not use this trit as a key or put secrets in it. -/
def sealOf (g : Body) : Nat := sumC g.corn (fins 20) % 3

theorem seal_upd (g : Body) (v : Fin 20) (t : Trit) :
    sumC (upd g.corn v t) (fins 20) + (g.corn v).code = sumC g.corn (fins 20) + t.code := by
  have h := sumC_upd g.corn v t (fins 20)
  rw [cnt_fins v, Nat.one_mul, Nat.one_mul] at h
  exact h

/-- Four truthful local views determine the sum modulo three. -/
theorem seal_known_to_four (g g' : Body) (x : Fin 5) (h : ∀ c, c ≠ x → view g c = view g' c) : sealOf g = sealOf g' := by
  unfold sealOf; rw [four_see_all g g' x h]

/-- Every realizable three-organ view permits each of the three sums. For any target, setting one unseen corner
    produces a body with that sum and the same three views. This is possibilistic hiding. -/
theorem seal_hidden_from_three (g : Body) (x y : Fin 5) (hxy : x ≠ y) (target : Nat) (ht : target < 3) :
    ∃ g' : Body, (∀ c, c ≠ x → c ≠ y → view g' c = view g c) ∧ sealOf g' = target := by
  have hv := blind_corner x y hxy
  generalize blindOf x y = v at hv
  refine ⟨⟨g.priv, upd g.corn v (Trit.ofCode (target + (g.corn v).code + 2 * sumC g.corn (fins 20)))⟩, ?_, ?_⟩
  · intro c cx cy
    apply Report.ext'
    · rfl
    · funext j
      show upd g.corn v _ (slot c j) = g.corn (slot c j)
      have ne : slot c j ≠ v := by
        intro k
        rcases slots c j with e | e
        · have o : (home1 v).1 = c := by rw [← k, e]
          rcases hv with ⟨a, _⟩ | ⟨a, _⟩
          · exact cx (o.symm.trans a)
          · exact cy (o.symm.trans a)
        · have o : (home2 v).1 = c := by rw [← k, e]
          rcases hv with ⟨_, b⟩ | ⟨_, b⟩
          · exact cy (o.symm.trans b)
          · exact cx (o.symm.trans b)
      unfold upd; rw [if_neg ne]
  · have h := seal_upd g v (Trit.ofCode (target + (g.corn v).code + 2 * sumC g.corn (fins 20)))
    have hc := code_ofCode (target + (g.corn v).code + 2 * sumC g.corn (fins 20))
    have ho := code_lt (g.corn v)
    show sumC (upd g.corn v _) (fins 20) % 3 = target
    omega

end Pentora
