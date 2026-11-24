/- SHA-256 on bytes. FIPS 180-4, §§5.1.1, 5.3.3, 6.2.
   The message schedule uses a sixteen-word sliding window. -/
namespace Aukora.Sha256

private structure Working where
  a : UInt32
  b : UInt32
  c : UInt32
  d : UInt32
  e : UInt32
  f : UInt32
  g : UInt32
  h : UInt32

private structure Window where
  w0 : UInt32
  w1 : UInt32
  w2 : UInt32
  w3 : UInt32
  w4 : UInt32
  w5 : UInt32
  w6 : UInt32
  w7 : UInt32
  w8 : UInt32
  w9 : UInt32
  w10 : UInt32
  w11 : UInt32
  w12 : UInt32
  w13 : UInt32
  w14 : UInt32
  w15 : UInt32

@[inline] private def rotr (x n : UInt32) := (x >>> n) ||| (x <<< (32 - n))
@[inline] private def big0 (x : UInt32) := rotr x 2 ^^^ rotr x 13 ^^^ rotr x 22
@[inline] private def big1 (x : UInt32) := rotr x 6 ^^^ rotr x 11 ^^^ rotr x 25
@[inline] private def small0 (x : UInt32) := rotr x 7 ^^^ rotr x 18 ^^^ (x >>> 3)
@[inline] private def small1 (x : UInt32) := rotr x 17 ^^^ rotr x 19 ^^^ (x >>> 10)

private def constants : List UInt32 := [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]

private def rounds : List UInt32 → Window → Working → Working
  | [], _, s => s
  | k :: ks, w, s =>
    let next := small1 w.w14 + w.w9 + small0 w.w1 + w.w0
    let t1 := s.h + big1 s.e + ((s.e &&& s.f) ^^^ ((~~~s.e) &&& s.g)) + k + w.w0
    let t2 := big0 s.a + ((s.a &&& s.b) ^^^ (s.a &&& s.c) ^^^ (s.b &&& s.c))
    rounds ks ⟨w.w1, w.w2, w.w3, w.w4, w.w5, w.w6, w.w7, w.w8, w.w9,
               w.w10, w.w11, w.w12, w.w13, w.w14, w.w15, next⟩
              ⟨t1 + t2, s.a, s.b, s.c, s.d + t1, s.e, s.f, s.g⟩

/-- Read the original message followed by the one bit, zero padding and 64-bit bit length. -/
private def paddedByte (msg : ByteArray) (paddedLength i : Nat) : UInt32 :=
  if h : i < msg.size then msg[i].toUInt32
  else if i == msg.size then 0x80
  else if i + 8 ≥ paddedLength then
    let shift := ((paddedLength - 1 - i) * 8).toUInt64
    (((msg.size.toUInt64 * 8) >>> shift).toUInt8).toUInt32
  else 0

private def compress (msg : ByteArray) (paddedLength offset : Nat) (s : Working) : Working :=
  let word := fun (i : Nat) =>
    let j := offset + i * 4
    paddedByte msg paddedLength j <<< 24 ||| paddedByte msg paddedLength (j + 1) <<< 16 |||
      paddedByte msg paddedLength (j + 2) <<< 8 ||| paddedByte msg paddedLength (j + 3)
  let r := rounds constants
    ⟨word 0, word 1, word 2, word 3, word 4, word 5, word 6, word 7,
     word 8, word 9, word 10, word 11, word 12, word 13, word 14, word 15⟩ s
  ⟨s.a+r.a, s.b+r.b, s.c+r.c, s.d+r.d, s.e+r.e, s.f+r.f, s.g+r.g, s.h+r.h⟩

private def blocks (msg : ByteArray) (paddedLength : Nat) : Nat → Nat → Working → Working
  | 0, _, s => s
  | n+1, offset, s =>
    blocks msg paddedLength n (offset + 64) (compress msg paddedLength offset s)

private def writeWord (w : UInt32) (rest : List UInt8) : List UInt8 :=
  (w >>> 24).toUInt8 :: (w >>> 16).toUInt8 :: (w >>> 8).toUInt8 :: w.toUInt8 :: rest

def hash (msg : ByteArray) : List UInt8 :=
  let count := (msg.size + 72) / 64
  let s := blocks msg (count * 64) count 0
    ⟨0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19⟩
  writeWord s.a (writeWord s.b (writeWord s.c (writeWord s.d
    (writeWord s.e (writeWord s.f (writeWord s.g (writeWord s.h [])))))))

end Aukora.Sha256
