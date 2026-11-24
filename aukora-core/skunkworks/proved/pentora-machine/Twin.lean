import Pentora
/-! # Two figures and the faces between them

Part 4 of the Pentora machine. The golden flip sends φ to 1 - φ (so a + b·φ becomes (a + b) - b·φ). It keeps every
whole-number relation, so the flipped figure is again five cubes in a dodecahedron. This file proves where the figure
and its flipped twin meet, and what a face of the figure carries. Core Lean 4.19.0, nothing beyond `Pentora.lean`. -/
namespace Pentora

def Zphi.conj (x : Zphi) : Zphi := ⟨x.a + x.b, -x.b⟩
def conjPt (p : Pt) : Pt := (p.1.conj, p.2.1.conj, p.2.2.conj)
/-- Vertex i of the flipped twin. -/
def tvtx (i : Nat) : Pt := conjPt (vtx i)
def isRational (p : Pt) : Bool := p.1.b == 0 && p.2.1.b == 0 && p.2.2.b == 0

def cubeOkOn (pt : Nat → Pt) (c : List Nat) : Bool :=
  c.length == 8 && c.all fun v =>
    let ds := (c.filter (· != v)).map fun w => dist2 (pt v) (pt w)
    ds.count ⟨4, 0⟩ == 3 && ds.count ⟨8, 0⟩ == 3 && ds.count ⟨12, 0⟩ == 1

/-- The 27 cells of a cube (with repeats): 8 corners and the middle of every pair of corners. -/
def cellsOn (pt : Nat → Pt) (c : List Nat) : List Pt :=
  c.map (fun v => corner4 (pt v)) ++
  c.flatMap fun v => (c.filter fun w => decide (v < w)).map fun w => mid (pt v) (pt w)
def figureOn (pt : Nat → Pt) : List Pt := (cubeTable.flatMap (cellsOn pt)).eraseDups
def cube0Cells : List Pt := (cellsOn vtx (cube 0)).eraseDups

/-- THE FLIP KEEPS ONE CUBE. The corners it leaves in place are exactly the eight corners of cube 0. -/
theorem flip_fixes_cube0 :
    ((List.range 20).filter fun i => conjPt (vtx i) == vtx i) = cube 0 := by decide +kernel

/-- THE TWIN IS A PENTORA. The flipped points are 20 different points and the same five lists are cubes there too. -/
theorem twin_is_a_pentora :
    ((List.range 20).map tvtx).eraseDups.length = 20 ∧ cubeTable.all (cubeOkOn tvtx) = true := by decide +kernel

/-- TWO FIGURES MEET IN ONE CUBE. Each figure has 111 cells. They have exactly 27 in common, and those are the 27
    cells of cube 0: its 8 corners, 12 edge middles, 6 face centres and the centre. -/
theorem two_figures_share_one_cube :
    (figureOn vtx).length = 111 ∧ (figureOn tvtx).length = 111 ∧ cube0Cells.length = 27 ∧
    ((figureOn vtx).filter (figureOn tvtx).contains).length = 27 ∧
    (((figureOn vtx).filter (figureOn tvtx).contains).all cube0Cells.contains) = true := by decide +kernel

/-- WHAT THEY SHARE IS EXACTLY THE RATIONAL PART. A cell of the figure has whole-number coordinates (no φ) exactly
    when it is one of the 27 cells of cube 0. -/
theorem rational_cells_are_cube0 :
    ((figureOn vtx).filter isRational).length = 27 ∧
    (((figureOn vtx).filter isRational).all cube0Cells.contains) = true := by decide +kernel

/-- Each corner of cube 0 belongs to exactly one other cube of its figure; the same holds in the twin. So where the
    two figures meet, every shared corner has THREE owners: the shared cube, one cube of each figure. -/
theorem shared_corner_three_owners :
    ((cube 0).all fun v => ((cubeTable.drop 1).filter (·.contains v)).length == 1) = true := by decide +kernel

/-- Two of three. -/
def maj (a b c : Trit) : Trit := if a = b then a else if a = c then a else b

/-- THREE OWNERS OUTVOTE ONE LIE. If at most one of three reports of a cell is wrong, the majority is the truth.
    At a shared corner a single false owner is not only caught, it is overruled on the spot. -/
theorem majority_true (t a b c : Trit) (h : (a = t ∧ b = t) ∨ (a = t ∧ c = t) ∨ (b = t ∧ c = t)) :
    maj a b c = t := by
  cases t <;> cases a <;> cases b <;> cases c <;> simp_all [maj]

/-! ## The twelve faces -/

def faceTable : List (List Nat) := [[0, 1, 9, 10, 15], [0, 2, 8, 9, 14], [0, 4, 8, 10, 16], [1, 3, 11, 15, 17], [1, 5, 10, 11, 16], [2, 3, 9, 13, 15], [2, 6, 13, 14, 19], [3, 7, 13, 17, 19], [4, 5, 12, 16, 18], [4, 6, 8, 12, 14], [5, 7, 11, 17, 18], [6, 7, 12, 18, 19]]

/-- A face: five corners, each with two neighbours at the dodecahedron's edge and two across a diagonal. The
    diagonal has squared length 4: it is an edge of a cube. -/
def faceOk (f : List Nat) : Bool :=
  f.length == 5 && f.all fun v =>
    let ds := (f.filter (· != v)).map fun w => dist2 (vtx v) (vtx w)
    ds.count ⟨8, -4⟩ == 2 && ds.count ⟨4, 0⟩ == 2

theorem twelve_faces : faceTable.length = 12 ∧ faceTable.all faceOk = true := by decide +kernel

/-- EVERY FACE CARRIES ALL FIVE CUBES, ONCE EACH. Each cube meets each face in exactly two corners: one diagonal of
    the pentagon is one edge of that cube. -/
theorem face_meets_every_cube_once :
    (faceTable.all fun f => cubeTable.all fun c => (f.filter c.contains).length == 2) = true := by decide +kernel

/-- The five corners of a face are owned by five different pairs of cubes. -/
theorem face_has_five_pairs :
    (faceTable.all fun f => ((f.map fun v => cubeTable.map (·.contains v)).eraseDups).length == 5) = true := by
  decide +kernel

theorem corner_in_three_faces :
    ((List.range 20).all fun v => (faceTable.filter (·.contains v)).length == 3) = true := by decide +kernel

/-- A face is five three-valued cells: 243 states, one byte. -/
theorem face_fits_a_byte : 3 ^ 5 < 256 := by decide

end Pentora
