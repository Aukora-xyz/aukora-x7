import SegmentFinal
import Init.Data.Array.Extract

namespace Aukora.ChainFinal
open SegmentFinal
open private Sha256.writeWord from Crypto.Sha256

private def bytes (a : ByteArray) := a.data.toList

private theorem bytes_inj {a b : ByteArray} (h : bytes a = bytes b) : a = b := by
  rcases a with ⟨⟨a⟩⟩
  rcases b with ⟨⟨b⟩⟩
  exact congrArg (fun xs => ByteArray.mk (List.toArray xs)) h

@[simp] private theorem bytes_length (a : ByteArray) : (bytes a).length = a.size := by cases a; rfl

@[simp] private theorem bytes_append (a b : ByteArray) : bytes (a ++ b) = bytes a ++ bytes b := by
  rcases a with ⟨a⟩
  rcases b with ⟨b⟩
  change (a.extract 0 a.size ++ b.extract 0 (0 + b.size) ++
    a.extract (a.size + min b.size (b.size - 0)) a.size).toList = _
  have empty : a.extract (a.size + b.size) a.size = #[] := Array.extract_eq_empty_of_le (by omega)
  rw [Nat.zero_add,Nat.sub_zero,Nat.min_self,empty,Array.extract_eq_self_of_le (Nat.le_refl _),
    Array.extract_eq_self_of_le (Nat.le_refl _)]
  simp [bytes]

private theorem toByteSize (l : List UInt8) : l.toByteArray.size = l.length := by
  have invariant (xs : List UInt8) (s : ByteArray) : (List.toByteArray.loop xs s).size = s.size + xs.length := by
    induction xs generalizing s with
    | nil => simp [List.toByteArray.loop]
    | cons x xs ih =>
      rw [List.toByteArray.loop,ih]
      cases s
      simp [ByteArray.size,ByteArray.push,Nat.add_assoc,Nat.add_comm,Nat.add_left_comm]
  exact (invariant l ByteArray.empty).trans (Nat.zero_add _)

theorem digest_width (x : ByteArray) : (digest x).size = 32 := by
  rw [digest,toByteSize]
  simp only [Sha256.hash,Sha256.writeWord,List.length_cons,List.length_nil]

structure Mark where
  kind : UInt8
  wire : ByteArray

/-- These are the two real preimages used to seed a segment's entry accumulator. -/
inductive Seed where
  | first (law keys : ByteArray)
  | continuation (sealedHead law keys : ByteArray)

def Seed.data : Seed → ByteArray
  | .first law keys => "AUKORA/R12B/first".toUTF8 ++ law ++ keys
  | .continuation head law keys => genesisData head law keys

theorem first_seed (law : ByteArray) (s : Release.State) :
    digest (Seed.first law (keyData s)).data = first law s := rfl

private theorem entry_fields {a b : ByteArray} {i j : Mark} (width : a.size = b.size)
    (eq : entryData a i.kind i.wire = entryData b j.kind j.wire) : a = b ∧ i = j := by
  have h := congrArg bytes eq
  simp only [entryData,bytes_append,List.append_assoc,List.append_right_inj] at h
  have fields := List.append_inj h (by simpa only [bytes_length] using width)
  have tail : i.kind :: bytes i.wire = j.kind :: bytes j.wire := fields.2
  obtain ⟨kind,wire⟩ := List.cons.inj tail
  exact ⟨bytes_inj fields.1,by cases i; cases j; congr 1; exact bytes_inj wire⟩

private theorem seed_ne_entry (seed : Seed) (prior : ByteArray) (e : Mark) :
    seed.data ≠ entryData prior e.kind e.wire := by
  intro eq
  have marker := congrArg (fun b => (bytes b)[12]?) eq
  have entryWidth : 12 < (bytes entryTag).length := by decide
  have firstWidth : 12 < (bytes "AUKORA/R12B/first".toUTF8).length := by decide
  have genWidth : 12 < (bytes "AUKORA/R12B/genesis".toUTF8).length := by decide
  cases seed <;> simp only [Seed.data,genesisData,entryData,bytes_append,List.append_assoc,
    List.getElem?_append_left entryWidth,List.getElem?_append_left firstWidth,
    List.getElem?_append_left genWidth] at marker <;> contradiction

/-- Reverse order gives the final link's predecessor directly. `fold_entries` below
    identifies this definition with the public accumulator updated in arrival order. -/
def tip (seed : Seed) : List Mark → ByteArray
  | [] => seed.data
  | e :: rest => entryData (digest (tip seed rest)) e.kind e.wire

def inputs (seed : Seed) : List Mark → List ByteArray
  | [] => [seed.data]
  | e :: rest => tip seed (e :: rest) :: inputs seed rest

theorem fold_entries (seed : Seed) (reversed : List Mark) :
    digest (tip seed reversed) =
      reversed.reverse.foldl (fun head e => entry head e.kind e.wire) (digest seed.data) := by
  induction reversed with
  | nil => rfl
  | cons e xs ih => simp only [List.reverse_cons,List.foldl_append,List.foldl_cons,List.foldl_nil,← ih]; rfl

/-- Only preimages actually encountered on the two finite paths are assumed to
    distinguish their hashes. The paths may have different numbers of entries. -/
def NoCollision (xs ys : List ByteArray) : Prop :=
  ∀ a ∈ xs, ∀ b ∈ ys, digest a = digest b → a = b

private theorem here (s : Seed) (xs : List Mark) : tip s xs ∈ inputs s xs := by
  cases xs <;> simp [tip,inputs]

theorem journal_binds (a b : Seed) (xs ys : List Mark) (safe : NoCollision (inputs a xs) (inputs b ys))
    (eq : digest (tip a xs) = digest (tip b ys)) : a.data = b.data ∧ xs = ys := by
  induction xs generalizing ys with
  | nil =>
    have orig := safe _ (here ..) _ (here ..) eq
    cases ys with
    | nil => exact ⟨orig,rfl⟩
    | cons e es => exact False.elim (seed_ne_entry a _ e orig)
  | cons x xs ih =>
    have orig := safe _ (here ..) _ (here ..) eq
    cases ys with
    | nil => exact False.elim (seed_ne_entry b _ x orig.symm)
    | cons y ys =>
      have fields := entry_fields ((digest_width _).trans (digest_width _).symm) orig
      have tails : NoCollision (inputs a xs) (inputs b ys) :=
        fun p hp q hq => safe p (List.mem_cons_of_mem _ hp) q (List.mem_cons_of_mem _ hq)
      obtain ⟨seed,prior⟩ := ih ys tails fields.1
      exact ⟨seed,by rw [fields.2,prior]⟩

structure Record where
  marks : List Mark
  wire : ByteArray
  law : ByteArray
  state : Release.State

def Record.next (r : Record) := Seed.continuation (sealHead r.wire) r.law (keyData r.state)
def Record.accepts (s : Seed) (r : Record) : Prop :=
  closeRecord (digest (tip s r.marks.reverse)) r.law r.wire r.state = some (sealHead r.wire)

structure Edge (a b : Seed) (x y : Record) : Prop where
  left : x.accepts a
  right : y.accepts b
  journal : NoCollision (inputs a x.marks.reverse) (inputs b y.marks.reverse)
  seals : digest x.wire = digest y.wire → x.wire = y.wire
  genesis : digest x.next.data = digest y.next.data → x.next.data = y.next.data

private theorem next_head {x y : Record} (eq : x.next.data = y.next.data) :
    digest x.wire = digest y.wire := by
  have h := congrArg bytes eq
  simp only [Record.next,Seed.data,genesisData,bytes_append,List.append_assoc,List.append_right_inj] at h
  apply bytes_inj
  exact List.append_inj_left h (by simp [sealHead,digest_width])

theorem altered_record_changes_next {a b : Seed} {x y : Record} (edge : Edge a b x y)
    (changed : a.data ≠ b.data ∨ x.marks ≠ y.marks) : x.next.data ≠ y.next.data := by
  intro same
  have wires := edge.seals (next_head same)
  have left := (seal_authentic edge.left).2.1
  have right := (seal_authentic edge.right).2.1
  rw [wires] at left
  obtain ⟨seed,actions⟩ := journal_binds _ _ _ _ edge.journal (left.symm.trans right)
  exact changed.elim (· seed) (fun h => h (List.reverse_inj.mp actions))

/-- Distinct authenticated trailers also distinguish the continuation when the
    two journals themselves coincide, including distinct valid signatures. -/
theorem altered_trailer_changes_next {a b : Seed} {x y : Record} (edge : Edge a b x y)
    (different : x.wire ≠ y.wire) : x.next.data ≠ y.next.data ∧
      digest x.next.data ≠ digest y.next.data := by
  have descriptor : x.next.data ≠ y.next.data := fun eq => different (edge.seals (next_head eq))
  exact ⟨descriptor,fun eq => descriptor (edge.genesis eq)⟩

theorem altered_record_changes_head {a b : Seed} {x y : Record} (edge : Edge a b x y)
    (changed : a.data ≠ b.data ∨ x.marks ≠ y.marks) : digest x.next.data ≠ digest y.next.data :=
  fun equality => altered_record_changes_next edge changed (edge.genesis equality)

/-- The actual continuation entry point exposes the changed digest as its ledger head. -/
theorem continued_head_changes {a b : Seed} {x y : Record} (edge : Edge a b x y)
    (changed : a.data ≠ b.data ∨ x.marks ≠ y.marks) {gx gy afterX afterY}
    (left : continueAt (sealHead x.wire) x.law gx x.state = some afterX)
    (right : continueAt (sealHead y.wire) y.law gy y.state = some afterY) :
    Safe11.head afterX ≠ Safe11.head afterY := by
  have lx := continuation left
  have ry := continuation right
  intro eq
  have ls : gx = x.next.data := lx.1
  have rs : gy = y.next.data := ry.1
  have hashed := lx.2.1.symm.trans (eq.trans ry.2.1)
  apply altered_record_changes_head edge changed
  rw [← ls,← rs]
  apply @bytes_inj (digest gx) (digest gy)
  exact Digest.mk.inj hashed

def Consecutive (a b : Seed) : List (Record × Record) → Prop
  | [] => True
  | (x,y) :: more => Edge a b x y ∧ Consecutive x.next y.next more

/-- Once two valid records diverge, all subsequent paired genesis descriptors
    differ, for arbitrary later marks, keys, laws and valid signed trailers. -/
theorem every_later_genesis {a b : Seed} {pairs : List (Record × Record)}
    (chain : Consecutive a b pairs) (different : a.data ≠ b.data) :
    ∀ p ∈ pairs, p.1.next.data ≠ p.2.next.data ∧
      digest p.1.next.data ≠ digest p.2.next.data := by
  induction pairs generalizing a b with
  | nil => simp
  | cons pair more ih =>
    obtain ⟨x,y⟩ := pair
    have changed := altered_record_changes_next chain.1 (Or.inl different)
    intro p mem
    rcases List.mem_cons.mp mem with rfl | tail
    · exact ⟨changed,altered_record_changes_head chain.1 (Or.inl different)⟩
    · exact ih chain.2 changed p tail

/-- A change to an entry, a sidecar or the signed trailer of any selected pair
    distinguishes that continuation and every valid pair of its descendants. -/
theorem tampering_propagates {a b : Seed} {x y : Record} {suffix : List (Record × Record)}
    (edge : Edge a b x y) (later : Consecutive x.next y.next suffix)
    (changed : a.data ≠ b.data ∨ x.marks ≠ y.marks ∨ x.wire ≠ y.wire) :
    ∀ p ∈ (x,y) :: suffix, p.1.next.data ≠ p.2.next.data ∧
      digest p.1.next.data ≠ digest p.2.next.data := by
  have start : x.next.data ≠ y.next.data ∧ digest x.next.data ≠ digest y.next.data := by
    rcases changed with seed | actions | trailer
    · exact ⟨altered_record_changes_next edge (.inl seed),altered_record_changes_head edge (.inl seed)⟩
    · exact ⟨altered_record_changes_next edge (.inr actions),altered_record_changes_head edge (.inr actions)⟩
    · exact altered_trailer_changes_next edge trailer
  intro p here
  rcases List.mem_cons.mp here with rfl | rest
  · exact start
  · exact every_later_genesis later start.1 p rest

#print axioms tampering_propagates
#print axioms journal_binds
#print axioms altered_record_changes_next
#print axioms continued_head_changes
#print axioms every_later_genesis
end Aukora.ChainFinal
