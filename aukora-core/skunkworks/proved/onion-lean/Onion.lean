/-! The totals tree ("onion"), as laws (side lab, in no repository). Core Lean only.

Every node carries a digest and a total. A parent's total is the sum of its children's totals, and a parent's digest
commits to EACH child's total and digest (not only to the sum: that was the hole found in the first brief).
The format is a parameter, so the laws hold for any digest, any fixed-width encoding of totals and any two tags.
The builder lane's JavaScript tree has this shape: leaf = H(2 ‖ totals ‖ line digest), join = H(3 ‖ left totals ‖
right totals ‖ left digest ‖ right digest).

NAMED ASSUMPTIONS (`Sound`), not proved of any real hash or encoding: no collisions; digests of one length;
encodings of one length; the encoding is one-to-one ON TOTALS IN RANGE; the two tags differ.
The range condition is not decoration. A total outside the range (an overflow, or a "negative" amount written as a
huge number) can share an encoding with an honest one, so every total a checker meets must be range-checked. -/
namespace Onion

abbrev Bytes := List Nat

structure Format (T : Type) where
  H : Bytes → Bytes
  enc : T → Bytes
  add : T → T → T
  Ranged : T → Prop
  n : Nat
  e : Nat
  leafTag : Nat
  joinTag : Nat

structure Sound {T : Type} (f : Format T) : Prop where
  noCollision : ∀ a b, f.H a = f.H b → a = b
  fixed : ∀ a, (f.H a).length = f.n
  encLen : ∀ t, (f.enc t).length = f.e
  encInj : ∀ a b, f.Ranged a → f.Ranged b → f.enc a = f.enc b → a = b
  tags : f.leafTag ≠ f.joinTag

structure Node (T : Type) where
  digest : Bytes
  total : T

inductive Tree (T : Type) where
  | leaf (payload : Bytes) (total : T)
  | node (l r : Tree T)

variable {T : Type}

def join (f : Format T) (a b : Node T) : Node T :=
  ⟨f.H (f.joinTag :: (f.enc a.total ++ (f.enc b.total ++ (a.digest ++ b.digest)))), f.add a.total b.total⟩

def root (f : Format T) : Tree T → Node T
  | .leaf p t => ⟨f.H (f.leafTag :: (f.enc t ++ p)), t⟩
  | .node l r => join f (root f l) (root f r)

/-- The sum of the leaves' totals, in tree order. -/
def sum (f : Format T) : Tree T → T
  | .leaf _ t => t
  | .node l r => f.add (sum f l) (sum f r)

/-- CONSERVATION (the constant-sum law at every node). A node's total is exactly the sum of the leaves under it. -/
theorem total_is_sum (f : Format T) : ∀ t : Tree T, (root f t).total = sum f t
  | .leaf _ _ => rfl
  | .node l r => by simp [root, join, sum, total_is_sum f l, total_is_sum f r]

/-- Every total in the tree, leaf or inner, is in range. -/
def AllRanged (f : Format T) : Tree T → Prop
  | .leaf _ t => f.Ranged t
  | .node l r => AllRanged f l ∧ AllRanged f r ∧ f.Ranged (root f (.node l r)).total

theorem ranged_root (f : Format T) : ∀ {t : Tree T}, AllRanged f t → f.Ranged (root f t).total
  | .leaf _ _, h => h
  | .node _ _, h => h.2.2

theorem digest_len {f : Format T} (s : Sound f) : ∀ t : Tree T, (root f t).digest.length = f.n
  | .leaf _ _ => s.fixed _
  | .node _ _ => s.fixed _

/-- A join pins both children: their totals and their digests. -/
theorem join_inj {f : Format T} (s : Sound f) {a b a' b' : Node T}
    (ra : f.Ranged a.total) (rb : f.Ranged b.total) (ra' : f.Ranged a'.total) (rb' : f.Ranged b'.total)
    (la : a.digest.length = f.n) (la' : a'.digest.length = f.n)
    (h : (join f a b).digest = (join f a' b').digest) : a = a' ∧ b = b' := by
  have inner := s.noCollision _ _ h
  injection inner with _ rest
  obtain ⟨ea, rest⟩ := List.append_inj rest (by rw [s.encLen, s.encLen])
  obtain ⟨eb, rest⟩ := List.append_inj rest (by rw [s.encLen, s.encLen])
  obtain ⟨da, db⟩ := List.append_inj rest (by rw [la, la'])
  have ta := s.encInj _ _ ra ra' ea
  have tb := s.encInj _ _ rb rb' eb
  cases a; cases b; cases a'; cases b'
  simp_all

/-- THE ROOT BINDS THE TREE. Two trees with totals in range and the same root digest are the same tree: the same
    leaves in the same places, with the same totals at every node. -/
theorem root_binds {f : Format T} (s : Sound f) :
    ∀ t u : Tree T, AllRanged f t → AllRanged f u → (root f t).digest = (root f u).digest → t = u
  | .leaf p a, .leaf q b, ra, rb, h => by
    have inner := s.noCollision _ _ h
    injection inner with _ rest
    obtain ⟨ea, pq⟩ := List.append_inj rest (by rw [s.encLen, s.encLen])
    rw [s.encInj _ _ ra rb ea, pq]
  | .leaf _ _, .node _ _, _, _, h => by
    have inner := s.noCollision _ _ h
    injection inner with tag _
    exact absurd tag s.tags
  | .node _ _, .leaf _ _, _, _, h => by
    have inner := s.noCollision _ _ h
    injection inner with tag _
    exact absurd tag.symm s.tags
  | .node l r, .node l' r', rt, ru, h => by
    obtain ⟨el, er⟩ := join_inj s (ranged_root f rt.1) (ranged_root f rt.2.1) (ranged_root f ru.1)
      (ranged_root f ru.2.1) (digest_len s l) (digest_len s l') h
    rw [root_binds s l l' rt.1 ru.1 (congrArg Node.digest el), root_binds s r r' rt.2.1 ru.2.1 (congrArg Node.digest er)]

/-- `Sub s t`: s is t, or sits somewhere inside t. -/
inductive Sub : Tree T → Tree T → Prop where
  | here (t : Tree T) : Sub t t
  | left {s l : Tree T} (r : Tree T) : Sub s l → Sub s (.node l r)
  | right {s r : Tree T} (l : Tree T) : Sub s r → Sub s (.node l r)

theorem sub_trans {a b c : Tree T} (ab : Sub a b) (bc : Sub b c) : Sub a c := by
  induction bc with
  | here => exact ab
  | left r _ ih => exact .left r ih
  | right l _ ih => exact .right l ih

theorem sub_ranged (f : Format T) {s t : Tree T} (h : Sub s t) (rt : AllRanged f t) : AllRanged f s := by
  induction h with
  | here => exact rt
  | left r _ ih => exact ih rt.1
  | right l _ ih => exact ih rt.2.1

/-- A path from a node up to the root: at each step, the sibling and whether it sits on the left. -/
def climb (f : Format T) (x : Node T) : List (Bool × Node T) → Node T
  | [] => x
  | (true, s) :: ps => climb f (join f s x) ps
  | (false, s) :: ps => climb f (join f x s) ps

/-- What an honest checker verifies on the way up: every total it meets, given or computed, is in range, and
    every given digest has the right length. -/
def Checked (f : Format T) (x : Node T) : List (Bool × Node T) → Prop
  | [] => f.Ranged x.total ∧ x.digest.length = f.n
  | (true, s) :: ps => f.Ranged x.total ∧ x.digest.length = f.n ∧ f.Ranged s.total ∧ s.digest.length = f.n ∧ Checked f (join f s x) ps
  | (false, s) :: ps => f.Ranged x.total ∧ x.digest.length = f.n ∧ f.Ranged s.total ∧ s.digest.length = f.n ∧ Checked f (join f x s) ps

/-- PATH SOUNDNESS. If a checked path from x reaches the kept root (digest AND total), then x is the root of a real
    part of the tree, and so is every sibling the path named: their totals are the true sums of the leaves under
    them. Nothing can be moved between neighbours, and no total can be invented, without changing the root. -/
theorem climb_sound {f : Format T} (s : Sound f) {t : Tree T} (rt : AllRanged f t) :
    ∀ (ps : List (Bool × Node T)) (x : Node T), Checked f x ps → climb f x ps = root f t →
      (∃ sub, Sub sub t ∧ root f sub = x) ∧ ∀ p ∈ ps, ∃ q, Sub q t ∧ root f q = p.2
  | [], x, _, top => ⟨⟨t, .here t, top.symm⟩, by intro p hp; cases hp⟩
  | (side, sib) :: ps, x, ck, top => by
    cases side with
    | true =>
      obtain ⟨rx, lx, rs, ls, more⟩ := ck
      obtain ⟨⟨sub, inT, isJoin⟩, others⟩ := climb_sound s rt ps (join f sib x) more top
      cases sub with
      | leaf p a =>
        have inner := s.noCollision _ _ (congrArg Node.digest isJoin)
        injection inner with tag _
        exact absurd tag s.tags
      | node l r =>
        have rsub := sub_ranged f inT rt
        obtain ⟨el, er⟩ := join_inj s (ranged_root f rsub.1) (ranged_root f rsub.2.1) rs rx (digest_len s l) ls
          (congrArg Node.digest isJoin)
        refine ⟨⟨r, sub_trans (.right l (.here r)) inT, er⟩, ?_⟩
        intro p hp
        cases hp with
        | head => exact ⟨l, sub_trans (.left r (.here l)) inT, el⟩
        | tail _ rest => exact others p rest
    | false =>
      obtain ⟨rx, lx, rs, ls, more⟩ := ck
      obtain ⟨⟨sub, inT, isJoin⟩, others⟩ := climb_sound s rt ps (join f x sib) more top
      cases sub with
      | leaf p a =>
        have inner := s.noCollision _ _ (congrArg Node.digest isJoin)
        injection inner with tag _
        exact absurd tag s.tags
      | node l r =>
        have rsub := sub_ranged f inT rt
        obtain ⟨el, er⟩ := join_inj s (ranged_root f rsub.1) (ranged_root f rsub.2.1) rx rs (digest_len s l) lx
          (congrArg Node.digest isJoin)
        refine ⟨⟨l, sub_trans (.left r (.here l)) inT, el⟩, ?_⟩
        intro p hp
        cases hp with
        | head => exact ⟨r, sub_trans (.right l (.here r)) inT, er⟩
        | tail _ rest => exact others p rest

/-- INCLUSION. A checked path from a leaf to the kept root means that leaf, with that total, is in the tree. -/
theorem included {f : Format T} (s : Sound f) {t : Tree T} (rt : AllRanged f t) (payload : Bytes) (amount : T)
    (ps : List (Bool × Node T)) (ck : Checked f (root f (.leaf payload amount)) ps)
    (top : climb f (root f (.leaf payload amount)) ps = root f t) : Sub (.leaf payload amount) t := by
  obtain ⟨⟨sub, inT, same⟩, _⟩ := climb_sound s rt ps _ ck top
  have ranged : f.Ranged amount := by cases ps with
    | nil => exact ck.1
    | cons p _ => obtain ⟨b, _⟩ := p; cases b <;> exact ck.1
  have eq := root_binds s sub (.leaf payload amount) (sub_ranged f inT rt) ranged (congrArg Node.digest same)
  rw [← eq]; exact inT
end Onion
