/-! "This backup was not rewritten", as a law (side lab, in no repository). Core Lean only.

A record is a list of lines. Its head is a chain of digests: each new line is digested together with the head
before it. A reader keeps a CHECKPOINT of a record it once saw: how many lines, and the head. Later it is handed a
record (by a server, a backup, another device) and asks one question: is what I saw still there, unchanged, with
lines only added after it?

The theorem below says the checker's YES is exactly that fact, for every digest function that has no collisions
and gives digests of one fixed length. Those two properties are NAMED ASSUMPTIONS about the digest; nothing here
proves them of any real hash. Lists are written newest line first, so adding a line is `line :: record`. -/
namespace Backup

abbrev Bytes := List Nat
variable (H : Bytes → Bytes)

/-- The head of a record (newest first), starting from the genesis value `g`. -/
def head (g : Bytes) : List Bytes → Bytes
  | [] => g
  | line :: older => H (head g older ++ line)

/-- NAMED ASSUMPTION 1: no two different inputs have the same digest. -/
def NoCollision : Prop := ∀ a b, H a = H b → a = b
/-- NAMED ASSUMPTION 2: every digest has the same length. -/
def Fixed (n : Nat) : Prop := ∀ a, (H a).length = n

theorem head_length {n : Nat} (fx : Fixed H n) {g : Bytes} (lg : g.length = n) (r : List Bytes) :
    (head H g r).length = n := by
  cases r with
  | nil => exact lg
  | cons line older => exact fx _

/-- Two records of the same length with the same head are the same record. -/
theorem same_head_same_record {n : Nat} (nc : NoCollision H) (fx : Fixed H n) {g : Bytes} (lg : g.length = n) :
    ∀ xs ys : List Bytes, xs.length = ys.length → head H g xs = head H g ys → xs = ys
  | [], [], _, _ => rfl
  | [], _ :: _, len, _ => by simp at len
  | _ :: _, [], len, _ => by simp at len
  | x :: xs, y :: ys, len, eq => by
    have inner : head H g xs ++ x = head H g ys ++ y := nc _ _ eq
    have same : (head H g xs).length = (head H g ys).length := by
      rw [head_length H fx lg xs, head_length H fx lg ys]
    obtain ⟨heads, lines⟩ := List.append_inj inner same
    have rest := same_head_same_record nc fx lg xs ys (by simpa using len) heads
    rw [lines, rest]

/-- What a reader keeps: how many lines it saw, and the head then. -/
structure Checkpoint where
  count : Nat
  top : Bytes
  deriving DecidableEq

def checkpoint (g : Bytes) (seen : List Bytes) : Checkpoint := ⟨seen.length, head H g seen⟩

/-- The oldest `k` lines of a record written newest first. -/
def oldest (k : Nat) (r : List Bytes) : List Bytes := r.drop (r.length - k)

/-- The checker. 0 APPEND ONLY, 1 SHORTER (lines are missing), 2 REWRITTEN (the old part is not what was seen). -/
def verdict (g : Bytes) (c : Checkpoint) (now : List Bytes) : Nat :=
  if now.length < c.count then 1
  else if head H g (oldest c.count now) = c.top then 0 else 2

theorem oldest_append (added seen : List Bytes) : oldest seen.length (added ++ seen) = seen := by
  simp [oldest]

theorem oldest_length {k : Nat} {r : List Bytes} (le : k ≤ r.length) : (oldest k r).length = k := by
  simp [oldest]; omega

/-- THE LAW. The checker says APPEND ONLY exactly when the record now is the record seen then, with lines only
    added after it. Nothing was changed, dropped, reordered or inserted in the part that was seen. -/
theorem append_only_iff {n : Nat} (nc : NoCollision H) (fx : Fixed H n) {g : Bytes} (lg : g.length = n)
    (seen now : List Bytes) :
    verdict H g (checkpoint H g seen) now = 0 ↔ ∃ added, now = added ++ seen := by
  constructor
  · intro v
    unfold verdict checkpoint at v
    simp only at v
    by_cases short : now.length < seen.length
    · simp [short] at v
    · rw [if_neg short] at v
      by_cases eq : head H g (oldest seen.length now) = head H g seen
      · have le : seen.length ≤ now.length := Nat.le_of_not_lt short
        have same := same_head_same_record H nc fx lg _ _ (oldest_length le) eq
        refine ⟨now.take (now.length - seen.length), ?_⟩
        have split := (List.take_append_drop (now.length - seen.length) now).symm
        unfold oldest at same
        rw [same] at split
        exact split
      · rw [if_neg eq] at v; simp at v
  · rintro ⟨added, rfl⟩
    unfold verdict checkpoint
    simp only
    have ge : ¬ (added ++ seen).length < seen.length := by simp
    rw [if_neg ge, oldest_append, if_pos rfl]

/-- And the two refusals mean what they say. -/
theorem shorter_means_missing (g : Bytes) (seen now : List Bytes)
    (v : verdict H g (checkpoint H g seen) now = 1) : now.length < seen.length := by
  unfold verdict checkpoint at v
  simp only at v
  by_cases short : now.length < seen.length
  · exact short
  · rw [if_neg short] at v; split at v <;> simp at v

end Backup
