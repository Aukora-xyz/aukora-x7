import core.Sha512

/- Pure Ed25519 verification (RFC 8032, §§5.1.3 and 5.1.7).
   All scalars here are public. Arithmetic uses the ordinary Lean Nat runtime.
   This implementation is tested against vectors; its arithmetic is unproved. -/
namespace Aukora.Ed25519

-- p = 2^255 − 19, L = 2^252 + 27742317777372353535851937790883648493.
private def p : Nat := 57896044618658097711785492504343953926634992332820282019728792003956564819949
private def order : Nat := 7237005577332262213973186563042994240857116359379907606001950938285454250989

-- d = −121665/121666 and sqrtMinusOne = 2^((p−1)/4) in the field.
private def d : Nat := 37095705934669439343138083508754565189542113879843219016388785533085940283555
private def sqrtMinusOne : Nat := 19681161376707505956807079304988542015446066515923890162744021073123829784752

private def mul (a b : Nat) : Nat := a * b % p
private def add (a b : Nat) : Nat := (a + b) % p
private def sub (a b : Nat) : Nat := (a + p - b) % p

/-- Square and multiply, with an explicit bit bound for structural recursion. -/
private def powBits : Nat → Nat → Nat → Nat → Nat
  | 0, _, _, acc => acc
  | n+1, base, exponent, acc =>
    powBits n (mul base base) (exponent / 2)
      (if exponent % 2 == 1 then mul acc base else acc)

private def littleEndian (bs : List UInt8) : Nat :=
  bs.foldr (fun byte rest => byte.toNat + 256 * rest) 0

/-- Extended homogeneous Edwards coordinates (X/Z, Y/Z), XY = ZT. -/
private structure Point where
  x : Nat
  y : Nat
  z : Nat
  t : Nat

private def affine (x y : Nat) : Point := ⟨x, y, 1, mul x y⟩
private def identity : Point := ⟨0, 1, 1, 0⟩

-- The RFC base point has y=4/5 and the even square root for x.
private def basePoint : Point := affine
  15112221349535400772501151409588531511454012693041857206046113283949847762202
  46316835694926478169428394003475163141307993866256225615783033603165251855960

private def pointAdd (u v : Point) : Point :=
  let a := mul (sub u.y u.x) (sub v.y v.x)
  let b := mul (add u.y u.x) (add v.y v.x)
  let c := mul (mul 2 d) (mul u.t v.t)
  let hZ := mul 2 (mul u.z v.z)
  let e := sub b a
  let f := sub hZ c
  let g := add hZ c
  let h := add b a
  ⟨mul e f, mul g h, mul f g, mul e h⟩

private def pointEq (u v : Point) : Bool :=
  mul u.x v.z == mul v.x u.z && mul u.y v.z == mul v.y u.z

private def scaleBits : Nat → Nat → Point → Point → Point
  | 0, _, _, acc => acc
  | n+1, scalar, q, acc =>
    scaleBits n (scalar / 2) (pointAdd q q)
      (if scalar % 2 == 1 then pointAdd acc q else acc)

-- All callers supply scalars strictly below 2^255.
private def scale (scalar : Nat) (q : Point) : Point :=
  scaleBits 255 scalar q identity

private def decode (bs : List UInt8) : Option Point := do
  guard (bs.length == 32)
  let bits := littleEndian bs
  let sign := bits >>> 255
  let y := bits % (p + 19)
  guard (y < p)
  let yy := mul y y
  let u := sub yy 1
  let v := add (mul d yy) 1
  let vv := mul v v
  let v3 := mul vv v
  let v7 := mul (mul v3 v3) v
  let x0 := mul (mul u v3) (powBits 252 (mul u v7) ((p - 5) / 8) 1)
  let vx2 := mul v (mul x0 x0)
  let x ← if vx2 == u then some x0
    else if vx2 == sub 0 u then some (mul x0 sqrtMinusOne)
    else none
  guard (!(x == 0 && sign == 1))
  return affine (if x % 2 == sign then x else sub 0 x) y

/-- An owner key must encode a nonidentity point in the prime-order subgroup. -/
private def ownerPoint (key : List UInt8) : Option Point := do
  let a ← decode key
  guard (!pointEq a identity && pointEq (scale order a) identity)
  return a

def validKey (key : List UInt8) : Bool := (ownerPoint key).isSome

/-- Verify a pure Ed25519 signature using the uncofactored RFC equation.
    Keys are checked as at enrollment. With A in the prime-order subgroup, equality
    implies the decoded R also lies there. The lengths, encodings and S < L are checked. -/
def verify (key message signature : List UInt8) : Bool := Id.run do
  if signature.length != 64 then return false
  let encodedR := signature.take 32
  let s := littleEndian (signature.drop 32)
  if s ≥ order then return false
  let some a := ownerPoint key | return false
  let some r := decode encodedR | return false
  let challenge := littleEndian (Sha512.hash (encodedR ++ key ++ message).toByteArray) % order
  return pointEq (scale s basePoint) (pointAdd r (scale challenge a))

end Aukora.Ed25519
