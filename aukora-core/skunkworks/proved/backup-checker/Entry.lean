import Chain
import Sha256
/-! The door between the Wasm file and the proved text. It unpacks bytes, fixes the digest to SHA-256 (the Core's own
Lean implementation, copied unchanged from `v0.8/Crypto/Sha256.lean`) and calls `Backup.verdict`, the function the
law `append_only_iff` is about. Input: genesis (32 bytes), count (4 bytes, low byte first), kept head (32 bytes),
then the record oldest line first, each line as a 4-byte length (low byte first) and its bytes.
Anything else is refused with the value 0xFFFFFFFF. -/
namespace Backup

def sha (bs : Bytes) : Bytes :=
  (Aukora.Sha256.hash (ByteArray.mk ((bs.map fun n => n.toUInt8).toArray))).map fun b => b.toNat

def slice (b : ByteArray) (i n : Nat) : Bytes := ((b.extract i (i + n)).toList).map fun x => x.toNat
def word (b : ByteArray) (i : Nat) : Nat :=
  (b.get! i).toNat + 256 * (b.get! (i + 1)).toNat + 65536 * (b.get! (i + 2)).toNat + 16777216 * (b.get! (i + 3)).toNat

/-- The lines, NEWEST first (each parsed line is put in front), or `none` if the bytes do not end on a line. -/
def lines (b : ByteArray) : Nat → Nat → List Bytes → Option (List Bytes)
  | 0, i, acc => if i = b.size then some acc else none
  | fuel + 1, i, acc =>
    if i = b.size then some acc
    else if i + 4 ≤ b.size ∧ i + 4 + word b i ≤ b.size then
      lines b fuel (i + 4 + word b i) (slice b (i + 4) (word b i) :: acc)
    else none

@[export backup_verdict] def verdictBytes (b : ByteArray) : UInt32 :=
  if b.size < 68 then 0xFFFFFFFF else
  match lines b b.size 68 [] with
  | none => 0xFFFFFFFF
  | some now => (verdict sha (slice b 0 32) ⟨word b 32, slice b 36 32⟩ now).toUInt32

/-- The door adds nothing: on bytes that parse, the answer is `verdict` of the unpacked checkpoint and record. -/
theorem door_is_verdict (b : ByteArray) (now : List Bytes) (big : ¬ b.size < 68) (ok : lines b b.size 68 [] = some now) :
    verdictBytes b = (verdict sha (slice b 0 32) ⟨word b 32, slice b 36 32⟩ now).toUInt32 := by
  simp [verdictBytes, big, ok]
end Backup
