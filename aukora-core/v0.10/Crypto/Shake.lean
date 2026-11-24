import Init.Data.Array.Set

namespace Aukora.Shake7

-- Keccak-f[1600], 25 little-endian lanes indexed by x + 5*y (FIPS 202).
private abbrev State := Array UInt64

private def offsets : Array UInt64 := #[
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39,
  41, 45, 15, 21, 8, 18, 2, 61, 56, 14]

private def constants : Array UInt64 := #[
  0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000,
  0x000000000000808b, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
  0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
  0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003,
  0x8000000000008002, 0x8000000000000080, 0x000000000000800a, 0x800000008000000a,
  0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]

@[inline] private def rotl (word n : UInt64) := (word <<< n) ||| (word >>> (64 - n))

private def round (a : State) (rc : UInt64) : State := Id.run do
  let mut columns := #[]
  for x in [:5] do
    let parity := a.getD x 0 ^^^ a.getD (x + 5) 0 ^^^ a.getD (x + 10) 0 ^^^
      a.getD (x + 15) 0 ^^^ a.getD (x + 20) 0
    columns := columns.push parity
  let mut b := Array.replicate 25 0
  for x in [:5] do
    let d := columns.getD ((x + 4) % 5) 0 ^^^ rotl (columns.getD ((x + 1) % 5) 0) 1
    for y in [:5] do
      let i := x + 5 * y
      -- Theta, rho and pi, with all source reads from the previous round.
      b := b.setIfInBounds (y + 5 * ((2 * x + 3 * y) % 5)) (rotl (a.getD i 0 ^^^ d) (offsets.getD i 0))
  let mut next := #[]
  for y in [:5] do
    for x in [:5] do
      let row := 5 * y
      next := next.push (b.getD (row + x) 0 ^^^
        ((~~~ (b.getD (row + (x + 1) % 5) 0)) &&& b.getD (row + (x + 2) % 5) 0))
  return next.setIfInBounds 0 (next.getD 0 0 ^^^ rc)

private def permute (a : State) : State := constants.foldl round a

private abbrev rate : Nat := 136

/-- SHAKE's suffix is 0x1f. The final high bit shares that byte if only one byte remains. -/
private def padded (msg : ByteArray) (last i : Nat) : UInt64 :=
  let b : UInt8 := if h : i < msg.size then msg[i] else if i = msg.size then 0x1f else 0
  (if i = last then b ||| 0x80 else b).toUInt64

/-- Byte-oriented SHAKE256 with the requested output length in bytes (FIPS 202, §6.2). -/
def shake256 (msg : ByteArray) (outBytes : Nat) : ByteArray := Id.run do
  let blocks := msg.size / rate + 1
  let last := blocks * rate - 1
  let mut a : State := Array.replicate 25 0
  for j in [:blocks] do
    for lane in [:17] do
      let mut w : UInt64 := 0
      for k in [:8] do
        w := w ||| (padded msg last (j * rate + 8 * lane + k) <<< (8 * k).toUInt64)
      a := a.setIfInBounds lane (a.getD lane 0 ^^^ w)
    a := permute a
  let mut out := ByteArray.emptyWithCapacity outBytes
  for i in [:outBytes] do
    let offset := i % rate
    if i > 0 && offset == 0 then a := permute a
    out := out.push ((a.getD (offset / 8) 0 >>> (8 * (offset % 8)).toUInt64).toUInt8)
  return out

@[export r7_shake256]
def hash (msg : ByteArray) (outBytes : UInt32) : ByteArray := shake256 msg outBytes.toNat

end Aukora.Shake7
