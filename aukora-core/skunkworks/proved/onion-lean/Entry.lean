import Onion
import Sha256
/-! The door between the Wasm file and the laws of `Onion.lean`, for the builder lane's concrete format:
SHA-256; six totals, each written as 8 bytes, high byte first; a total is in range when it is at most 2^53 - 1;
leaf tag 2, join tag 3. Input: kept root totals (48 bytes), kept root digest (32), leaf totals (48), leaf payload
(32), then steps of 81 bytes: one byte (1 = the sibling is on the left, 0 = on the right), sibling totals (48),
sibling digest (32). Answer: 0 accepted, 1 rejected, 0xFFFFFFFF if the bytes are not of that shape. -/
namespace Onion

def sha (bs : Bytes) : Bytes :=
  (Aukora.Sha256.hash (ByteArray.mk ((bs.map fun n => n.toUInt8).toArray))).map fun b => b.toNat

def be8 (x : Nat) : Bytes := (List.range 8).map fun i => (x / 256 ^ (7 - i)) % 256
def enc6 (t : List Nat) : Bytes := (List.range 6).foldr (fun j acc => be8 (t.getD j 0) ++ acc) []
def limit : Nat := 9007199254740991

def fmt : Format (List Nat) where
  H := sha
  enc := enc6
  add := fun a b => List.zipWith (· + ·) a b
  Ranged := fun t => t.length = 6 ∧ ∀ x ∈ t, x ≤ limit
  n := 32
  e := 48
  leafTag := 2
  joinTag := 3

def rangedB (t : List Nat) : Bool := t.length == 6 && t.all fun x => decide (x ≤ limit)

theorem ranged_of {t : List Nat} (h : rangedB t = true) : fmt.Ranged t := by
  simp [rangedB] at h
  exact ⟨h.1, fun x hx => h.2 x hx⟩

/-- The checker's own walk, in booleans: every total in range, every digest 32 bytes, on the way up. -/
def checkedB (x : Node (List Nat)) : List (Bool × Node (List Nat)) → Bool
  | [] => rangedB x.total && x.digest.length == 32
  | (true, s) :: ps => rangedB x.total && x.digest.length == 32 && rangedB s.total && s.digest.length == 32 && checkedB (join fmt s x) ps
  | (false, s) :: ps => rangedB x.total && x.digest.length == 32 && rangedB s.total && s.digest.length == 32 && checkedB (join fmt x s) ps

theorem checked_of : ∀ (ps : List (Bool × Node (List Nat))) (x : Node (List Nat)), checkedB x ps = true → Checked fmt x ps
  | [], x, h => by
    simp [checkedB] at h
    exact ⟨ranged_of h.1, h.2⟩
  | (true, s) :: ps, x, h => by
    simp [checkedB] at h
    exact ⟨ranged_of h.1.1.1.1, h.1.1.1.2, ranged_of h.1.1.2, h.1.2, checked_of ps _ h.2⟩
  | (false, s) :: ps, x, h => by
    simp [checkedB] at h
    exact ⟨ranged_of h.1.1.1.1, h.1.1.1.2, ranged_of h.1.1.2, h.1.2, checked_of ps _ h.2⟩

def acceptB (kept x : Node (List Nat)) (ps : List (Bool × Node (List Nat))) : Bool :=
  checkedB x ps && ((climb fmt x ps).digest == kept.digest && (climb fmt x ps).total == kept.total)

/-- WHAT AN ACCEPTANCE MEANS. If the format is sound (the named assumptions) and the kept root is the root of a tree
    with totals in range, then an accepted leaf is in that tree, with that total. -/
theorem accept_sound (s : Sound fmt) {t : Tree (List Nat)} (rt : AllRanged fmt t) (payload : Bytes) (amount : List Nat)
    (ps : List (Bool × Node (List Nat)))
    (ok : acceptB (root fmt t) (root fmt (.leaf payload amount)) ps = true) : Sub (.leaf payload amount) t := by
  simp [acceptB] at ok
  have top : climb fmt (root fmt (.leaf payload amount)) ps = root fmt t := by
    cases h : climb fmt (root fmt (.leaf payload amount)) ps
    cases g : root fmt t
    simp [h, g] at ok
    simp [ok.2.1, ok.2.2]
  exact included s rt payload amount ps (checked_of ps _ ok.1) top

def slice (b : ByteArray) (i n : Nat) : Bytes := ((b.extract i (i + n)).toList).map fun x => x.toNat
def num8 (b : ByteArray) (i : Nat) : Nat := (List.range 8).foldl (fun acc k => acc * 256 + (b.get! (i + k)).toNat) 0
def totals (b : ByteArray) (i : Nat) : List Nat := (List.range 6).map fun j => num8 b (i + 8 * j)
def steps (b : ByteArray) (count : Nat) : List (Bool × Node (List Nat)) :=
  (List.range count).map fun k => ((b.get! (160 + 81 * k)).toNat == 1, ⟨slice b (160 + 81 * k + 49) 32, totals b (160 + 81 * k + 1)⟩)

@[export onion_verify] def verifyBytes (b : ByteArray) : UInt32 :=
  if b.size < 160 ∨ (b.size - 160) % 81 ≠ 0 then 0xFFFFFFFF else
  let count := (b.size - 160) / 81
  if (List.range count).any (fun k => (b.get! (160 + 81 * k)).toNat > 1) then 0xFFFFFFFF else
  let kept : Node (List Nat) := ⟨slice b 48 32, totals b 0⟩
  let leaf := root fmt (.leaf (slice b 128 32) (totals b 80))
  if acceptB kept leaf (steps b count) then 0 else 1
end Onion
