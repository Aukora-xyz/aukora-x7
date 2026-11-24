import Wire

namespace Aukora.Wire4

private theorem runBind (p : Reader α) (f : α → Reader β) (xs : Bytes) :
    (p >>= f) xs = (p xs).bind (fun out => f out.1 out.2) := rfl
#print axioms runBind

private theorem runMap (p : Reader α) (f : α → β) (xs : Bytes) :
    (f <$> p) xs = (p xs).bind (fun out => some (f out.1, out.2)) := rfl
#print axioms runMap

private theorem runPure (v : α) (xs : Bytes) : (pure v : Reader α) xs = some (v, xs) := rfl
#print axioms runPure

private theorem uint_prefix (k n : Nat) (rest : Bytes) (fits : n < 256 ^ k) :
    uint k (putUInt k n ++ rest) = some (n, rest) := by
  induction k generalizing n with
  | zero =>
    have : n = 0 := by simpa using fits
    simp [uint, putUInt, runPure, this]
  | succ k ih =>
    have hi : n / 256 < 256 ^ k :=
      (Nat.div_lt_iff_lt_mul (by decide)).mpr (by simpa [Nat.pow_succ] using fits)
    simp only [uint, putUInt, List.cons_append, runBind, byte, Option.bind_some, runPure,
      UInt8.toNat_ofNat', Nat.reducePow]
    simp [ih _ hi, Nat.mod_add_div]
#print axioms uint_prefix

private theorem char_length (c : Char) : 0 < (putChar c).length := by
  simp only [putChar]
  split
  · simp
  split
  · simp
  split <;> simp
#print axioms char_length

private theorem cont_prefix (n : Nat) (rest : Bytes) :
    continuation (contByte n :: rest) = some (n % 64, rest) := by
  simp (disch := omega) [continuation, contByte, runBind, byte, runPure, if_pos, if_neg,
    Nat.mod_eq_of_lt, Nat.add_sub_cancel_left]
#print axioms cont_prefix

private theorem scalar_prefix (c : Char) (min : Nat) (h : min ≤ c.toNat) (rest : Bytes) :
    scalar min c.toNat rest = some (c, rest) := by simp [scalar, h, runPure]
#print axioms scalar_prefix

private theorem char_prefix (c : Char) (rest : Bytes) :
    readChar (putChar c ++ rest) = some (c, rest) := by
  have upper : c.toNat < 1114112 := by
    have h : c.toNat < 55296 ∨ 57343 < c.toNat ∧ c.toNat < 1114112 := c.valid
    omega
  simp only [putChar]
  split
  · simp (disch := omega) [readChar, runBind, runMap, runPure, byte, if_pos, if_neg, Nat.mod_eq_of_lt]
  split
  · have rejoin : 64 * (c.toNat / 64) + c.toNat % 64 = c.toNat := by omega
    simp (disch := omega) [readChar, runBind, runPure, byte, if_pos, if_neg, Nat.mod_eq_of_lt,
      Nat.add_sub_cancel_left, cont_prefix, rejoin, scalar_prefix]
  split
  · have rejoin : 64 * (64 * (c.toNat / 4096) + c.toNat / 64 % 64) + c.toNat % 64 = c.toNat := by omega
    simp (disch := omega) [readChar, runBind, runPure, byte, if_pos, if_neg, Nat.mod_eq_of_lt,
      Nat.add_sub_cancel_left, cont_prefix, rejoin, scalar_prefix]
  · have rejoin : 64 * (64 * (64 * (c.toNat / 262144) + c.toNat / 4096 % 64) +
        c.toNat / 64 % 64) + c.toNat % 64 = c.toNat := by omega
    simp (disch := omega) [readChar, runBind, runPure, byte, if_pos, if_neg, Nat.mod_eq_of_lt,
      Nat.add_sub_cancel_left, cont_prefix, rejoin, scalar_prefix]
#print axioms char_prefix

private theorem utf8_size (cs : List Char) : cs.length ≤ (cs.flatMap putChar).length := by
  induction cs with
  | nil => simp
  | cons c cs ih =>
    have := char_length c
    simp only [List.length_cons, List.flatMap_cons, List.length_append]
    omega
#print axioms utf8_size

private theorem textLoop_chars (cs acc : List Char) (fuel : Nat) (enough : cs.length ≤ fuel) :
    textLoop fuel (cs.flatMap putChar) acc = some ⟨acc.reverse ++ cs⟩ := by
  induction cs generalizing fuel acc with
  | nil => cases fuel <;> simp [textLoop]
  | cons c cs ih =>
    cases fuel with
    | zero => simp at enough
    | succ k =>
      have hn : ¬(putChar c ++ cs.flatMap putChar).isEmpty = true := by
        have hl : 0 < (putChar c ++ cs.flatMap putChar).length := by
          rw [List.length_append]
          have := char_length c
          omega
        intro h
        rw [List.isEmpty_iff.mp h] at hl
        exact Nat.not_lt_zero _ hl
      simp [List.flatMap_cons, textLoop, hn, char_prefix, ih (c :: acc) k (by simpa using enough)]
#print axioms textLoop_chars

private theorem take_prefix (xs rest : Bytes) : takeBytes xs.length (xs ++ rest) = some (xs,rest) := by
  simp [takeBytes]
#print axioms take_prefix

private theorem digest_prefix (d : Digest) (rest : Bytes) (h : d.bytes.length = 32) :
    digestField (d.bytes ++ rest) = some (d, rest) := by
  simp [digestField, runBind, runMap, runPure, ← h, take_prefix]
#print axioms digest_prefix

private theorem blob_prefix (xs rest : Bytes) (fits : xs.length < 65536) :
    blob (putBlob xs ++ rest) = some (xs, rest) := by
  simp [blob, putBlob, List.append_assoc, runBind, uint_prefix 2 _ _ fits, take_prefix]
#print axioms blob_prefix

private theorem text_prefix (s : String) (rest : Bytes) (fits : (textBytes s).length < 65536) :
    textField (putText s ++ rest) = some (s, rest) := by
  have h := textLoop_chars s.data [] _ (utf8_size s.data)
  have htext : textLoop (textBytes s).length (textBytes s) [] = some s := by simpa [textBytes] using h
  simp [textField, putText, runBind, runMap, runPure, blob_prefix _ _ fits, htext]
#print axioms text_prefix

def FitsBody : Body → Prop
  | .deliver xs => xs.length < 65536
  | .install d => d.bytes.length = 32

/-- Exactly the field widths needed to encode a grant intent without truncation. -/
def FitsIntent (i : Intent) : Prop := FitsBody i.body ∧ (textBytes i.audience).length < 65536 ∧
  i.generation < 65536 ∧ i.nonce < 65536

private theorem body_prefix (b : Body) (rest : Bytes) (fits : FitsBody b) :
    bodyField (putBody b ++ rest) = some (b, rest) := by
  cases b with
  | deliver xs => simp [putBody, bodyField, runBind, runMap, runPure, byte, blob_prefix xs rest fits]
  | install d => simp [putBody, bodyField, runBind, runMap, runPure, byte, digest_prefix d rest fits]
#print axioms body_prefix

private theorem intent_prefix (i : Intent) (rest : Bytes) (fits : FitsIntent i) :
    intentField (putIntent i ++ rest) = some (i, rest) := by
  rcases fits with ⟨hb, ha, hg, hn⟩
  simp [putIntent, List.append_assoc, intentField, runBind, runMap, runPure, body_prefix _ _ hb,
    text_prefix _ _ ha, uint_prefix 2 _ _ hg, uint_prefix 2 _ _ hn]
#print axioms intent_prefix

private theorem bool_prefix (b : Bool) (rest : Bytes) :
    boolField (b.toUInt8 :: rest) = some (b, rest) := by cases b <;> rfl
#print axioms bool_prefix

private theorem data_loop (xs : Bytes) (acc : ByteArray) :
    (List.toByteArray.loop xs acc).data.toList = acc.data.toList ++ xs := by
  induction xs generalizing acc with
  | nil => simp [List.toByteArray.loop]
  | cons b bs ih => cases acc; simp [List.toByteArray.loop, ih, ByteArray.push, List.append_assoc]
#print axioms data_loop

private theorem data_bytes (xs : Bytes) : xs.toByteArray.data.toList = xs := by
  simp [List.toByteArray, data_loop, ByteArray.empty, ByteArray.emptyWithCapacity]
#print axioms data_bytes

private theorem frame_roundtrip (x : R2.Frame) (parent : x.parent.bytes.length = 32)
    (seq : x.seq < 256 ^ 8) (action : actionField (putAction x.action) = some (x.action, [])) :
    decode (encode x).toByteArray = some x := by
  simp [decode, encode, data_bytes, frameField, List.append_assoc, runBind, runMap, runPure,
    digest_prefix _ _ parent, uint_prefix 8 _ _ seq, action]
#print axioms frame_roundtrip

/-- Every wire-representable `say`, including its parent, full u64 sequence and Unicode text. -/
theorem say_roundtrip (d : Digest) (n : Nat) (s : String) (parent : d.bytes.length = 32)
    (seq : n < 2 ^ 64) (text : (textBytes s).length < 65536) :
    let x : R2.Frame := ⟨d, n, .base (.say s)⟩
    decode (encode x).toByteArray = some x := by
  apply frame_roundtrip _ parent seq
  have ht := text_prefix s [] text
  simp only [List.append_nil] at ht
  simp [putAction, putEvent, actionField, baseFields, runBind, byte, runMap, runPure, ht]
#print axioms say_roundtrip

/-- Every wire-representable `grant`, for both bodies and either signature-verdict bit. -/
theorem grant_roundtrip (d : Digest) (n : Nat) (i : Intent) (verified : Bool)
    (parent : d.bytes.length = 32) (seq : n < 2 ^ 64) (intent : FitsIntent i) :
    let x : R2.Frame := ⟨d, n, .base (.grant i verified)⟩
    decode (encode x).toByteArray = some x := by
  apply frame_roundtrip _ parent seq
  simp [putAction, putEvent, actionField, baseFields, runBind, byte, runMap, runPure,
    intent_prefix i _ intent, bool_prefix]
#print axioms grant_roundtrip

end Aukora.Wire4
