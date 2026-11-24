import Crypto.Shake
import Batteries.Tactic.OpenPrivate

namespace Aukora.Mldsa8

open private Shake7.permute Shake7.padded from Crypto.Shake

-- FIPS 204, ML-DSA-65. Verification arithmetic uses canonical residues;
-- the transform and its inverse require no Montgomery-domain conversions.
private abbrev Poly := Array UInt32
private abbrev q : UInt32 := 8380417
private abbrev gamma1 : UInt32 := 524288
private abbrev gamma2 : UInt32 := 261888
private abbrev normLimit : UInt32 := gamma1 - 196

@[inline] private def addQ (a b : UInt32) : UInt32 :=
  let s := a + b
  if s >= q then s - q else s

@[inline] private def subQ (a b : UInt32) : UInt32 :=
  if a < b then a + q - b else a - b

@[inline] private def mulQ (a b : UInt32) : UInt32 :=
  ((a.toUInt64 * b.toUInt64) % 8380417).toUInt32

@[inline] private def byteAt (s : ByteArray) (i : Nat) : UInt8 :=
  if h : i < s.size then s[i] else 0

-- The bit-reversed powers of the primitive 512th root from FIPS 204.
private def zetas : Poly := Id.run do
  let mut powers : Poly := #[1]
  for i in [:255] do
    powers := powers.push (mulQ (powers.getD i 0) 1753)
  let mut out : Poly := #[]
  for i in [:256] do
    let mut rev := 0
    for j in [:8] do
      rev := 2 * rev + ((i >>> j) % 2)
    out := out.push (powers.getD rev 0)
  return out

private def ntt (p : Poly) : Poly := Id.run do
  let mut a := p
  let mut k := 0
  for stage in [:8] do
    let half := 128 >>> stage
    for block in [:256 / (2 * half)] do
      k := k + 1
      let root := zetas.getD k 0
      let start := block * 2 * half
      for j in [start:start + half] do
        let lo := a.getD j 0
        let hi := mulQ root (a.getD (j + half) 0)
        a := a.setIfInBounds j (addQ lo hi)
        a := a.setIfInBounds (j + half) (subQ lo hi)
  return a

private def invNtt (p : Poly) : Poly := Id.run do
  let mut a := p
  let mut k := 256
  for stage in [:8] do
    let half := 1 <<< stage
    for block in [:256 / (2 * half)] do
      k := k - 1
      let root := q - zetas.getD k 0
      let start := block * 2 * half
      for j in [start:start + half] do
        let lo := a.getD j 0
        let hi := a.getD (j + half) 0
        a := a.setIfInBounds j (addQ lo hi)
        a := a.setIfInBounds (j + half) (mulQ root (subQ lo hi))
  -- 256 * 8347681 ≡ 1 mod q.
  return a.map (mulQ 8347681)

/-- A squeezing cursor over Keccak-f[1600]. Rates are in bytes. -/
private structure Xof where
  state : Array UInt64
  rate : Nat
  pos : Nat
  deriving Inhabited

-- SHAKE128 uses 168 bytes per block, SHAKE256 uses 136. Both use the
-- same domain suffix and the permutation already exercised in round 7.
private def absorb (msg : ByteArray) (rate : Nat) : Xof := Id.run do
  let blocks := msg.size / rate + 1
  let last := blocks * rate - 1
  let mut a : Array UInt64 := Array.replicate 25 0
  for j in [:blocks] do
    for lane in [:rate / 8] do
      let mut word : UInt64 := 0
      for k in [:8] do
        word := word ||| (Shake7.padded msg last (j * rate + 8 * lane + k) <<< (8 * k).toUInt64)
      a := a.setIfInBounds lane (a.getD lane 0 ^^^ word)
    a := Shake7.permute a
  return ⟨a, rate, 0⟩

@[inline] private def nextByte (s : Xof) : UInt8 × Xof :=
  let s := if s.pos == s.rate then {s with state := Shake7.permute s.state, pos := 0} else s
  let b := (s.state.getD (s.pos / 8) 0 >>> (8 * (s.pos % 8)).toUInt64).toUInt8
  (b, {s with pos := s.pos + 1})

-- RejNTTPoly has no fixed squeeze limit. The 23-bit samples are already
-- coefficients in the NTT representation of A[row,col].
private partial def rejectionPoly (s : Xof) (a : Poly) : Poly :=
  if a.size == 256 then a else
    let (b0, s) := nextByte s
    let (b1, s) := nextByte s
    let (b2, s) := nextByte s
    let v := b0.toUInt32 ||| (b1.toUInt32 <<< 8) ||| ((b2.toUInt32 &&& 127) <<< 16)
    rejectionPoly s (if v < q then a.push v else a)

private def matrixEntry (rho : ByteArray) (row col : Nat) : Poly :=
  rejectionPoly (absorb ((rho.push col.toUInt8).push row.toUInt8) 168) (Array.emptyWithCapacity 256)

private partial def pickBelowEq (s : Xof) (i : Nat) : Nat × Xof :=
  let (b, s) := nextByte s
  if b.toNat <= i then (b.toNat, s) else pickBelowEq s i

-- SampleInBall, with tau = 49. Sign bits occupy the first eight bytes
-- of the SHAKE256 stream. Index rejection continues across rate blocks.
private def challenge (c : ByteArray) : Poly := Id.run do
  let mut s := absorb c 136
  let mut signs : UInt64 := 0
  for k in [:8] do
    let (b, rest) := nextByte s
    s := rest
    signs := signs ||| (b.toUInt64 <<< (8 * k).toUInt64)
  let mut a : Poly := Array.replicate 256 0
  for i in [207:256] do
    let (j, rest) := pickBelowEq s i
    s := rest
    a := a.setIfInBounds i (a.getD j 0)
    a := a.setIfInBounds j (if (signs &&& 1) == 0 then 1 else q - 1)
    signs := signs >>> 1
  return a

-- For ML-DSA-65, both 10-bit t₁ and 20-bit z entries fit in a
-- three-byte window at every packing offset. Strip any neighboring bits.
@[inline] private def unpack (buf : ByteArray) (start width mask i : Nat) : UInt32 :=
  let bit := i * width
  let offset := start + bit / 8
  let x := (byteAt buf offset).toUInt32 ||| ((byteAt buf (offset + 1)).toUInt32 <<< 8) |||
    ((byteAt buf (offset + 2)).toUInt32 <<< 16)
  (x >>> (bit % 8).toUInt32) &&& mask.toUInt32

private def publicPoly (pk : ByteArray) (row : Nat) : Poly := Id.run do
  let mut t : Poly := Array.emptyWithCapacity 256
  for i in [:256] do
    t := t.push (unpack pk (32 + 320 * row) 10 0x3ff i <<< 13)
  return t

private def responses (sig : ByteArray) : Option (Array Poly) := do
  let mut polys := #[]
  for col in [:5] do
    let mut z : Poly := Array.emptyWithCapacity 256
    for i in [:256] do
      let w := unpack sig (48 + 640 * col) 20 0xfffff i
      let norm := if w <= gamma1 then gamma1 - w else w - gamma1
      if norm >= normLimit then failure
      z := z.push (subQ gamma1 w)
    polys := polys.push (ntt z)
  return polys

private def hints (sig : ByteArray) : Option (Array (Array Bool)) := do
  let start := 48 + 5 * 640
  let mut rows := #[]
  let mut used := 0
  for row in [:6] do
    let stop := (byteAt sig (start + 55 + row)).toNat
    if stop < used || stop > 55 then failure
    let mut flags := Array.replicate 256 false
    for j in [used:stop] do
      let idx := byteAt sig (start + j)
      if j > used && idx <= byteAt sig (start + j - 1) then failure
      flags := flags.setIfInBounds idx.toNat true
    rows := rows.push flags
    used := stop
  for j in [used:55] do
    if byteAt sig (start + j) != 0 then failure
  return rows

-- Decompose and UseHint. At the upper wrap, the low part is a-q,
-- including -1 at q-1. An exact half-step belongs to the lower high part.
private def useHint (a : UInt32) (hint : Bool) : UInt8 :=
  let d := 2 * gamma2
  let k := (a + gamma2 - 1) / d
  let inc := k < 16 && a > k * d
  let h := k &&& 15
  (if !hint then h else if inc then (h + 1) &&& 15 else (h + 15) &&& 15).toUInt8

private def highBits (pk : ByteArray) (zHat : Array Poly) (cHat : Poly)
    (h : Array (Array Bool)) : ByteArray := Id.run do
  let rho := pk.extract 0 32
  let mut packed := ByteArray.emptyWithCapacity (6 * 128)
  for row in [:6] do
    let mut w : Poly := Array.replicate 256 0
    for col in [:5] do
      let a := matrixEntry rho row col
      let z := zHat.getD col #[]
      for j in [:256] do
        w := w.setIfInBounds j (addQ (w.getD j 0) (mulQ (a.getD j 0) (z.getD j 0)))
    let tHat := ntt (publicPoly pk row)
    for j in [:256] do
      w := w.setIfInBounds j (subQ (w.getD j 0) (mulQ (cHat.getD j 0) (tHat.getD j 0)))
    let v := invNtt w
    let flags := h.getD row #[]
    for i in [:128] do
      let j := 2 * i
      let lo := useHint (v.getD j 0) (flags.getD j false)
      let hi := useHint (v.getD (j + 1) 0) (flags.getD (j + 1) false)
      packed := packed.push (lo ||| (hi <<< 4))
  return packed

/-- Pure ML-DSA-65.Verify with an empty context string (FIPS 204).
    Inputs are a raw public key, an arbitrary message, and a raw signature. -/
@[export r8_mldsa_verify]
def verify (pk msg sig : ByteArray) : Bool := Id.run do
  if pk.size != 1952 || sig.size != 3309 then return false
  let some h := hints sig | return false
  let some zHat := responses sig | return false
  let c := sig.extract 0 48
  let tr := Shake7.shake256 pk 64
  -- FIPS 204 sets mu = H(tr || 0x00 || context_length || context || msg).
  -- The empty context contributes its zero length and no context bytes.
  let mu := Shake7.shake256 (((tr.push 0).push 0) ++ msg) 64
  let w1 := highBits pk zHat (ntt (challenge c)) h
  let check := Shake7.shake256 (mu ++ w1) 48
  let mut diff : UInt8 := 0
  for i in [:48] do
    diff := diff ||| (byteAt check i ^^^ byteAt c i)
  return diff == 0

end Aukora.Mldsa8
