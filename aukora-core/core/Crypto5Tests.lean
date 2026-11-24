import core.Ed25519

namespace Aukora.Crypto5Tests

private def nibble (c : Char) : Option Nat :=
  if '0' ≤ c && c ≤ '9' then some (c.toNat - 48)
  else if 'a' ≤ c && c ≤ 'f' then some (c.toNat - 87)
  else none

private def pairs : List Char → Option (List UInt8)
  | [] => some []
  | a :: b :: rest => do
    let x ← nibble a
    let y ← nibble b
    return (x*16 + y).toUInt8 :: (← pairs rest)
  | [_] => none

private def parse (s : String) : IO (List UInt8) := do
  if s == "-" then return []
  let some bs := pairs s.toList | throw (IO.userError "malformed fixture")
  return bs

private def expect (label : String) (condition : Bool) : IO Unit := do
  unless condition do throw (IO.userError label)

private def flipFirst : List UInt8 → List UInt8
  | [] => []
  | b :: bs => (b ^^^ 1) :: bs

def run : IO Unit := do
  -- Independent OpenSSL SHA-512 values across the 112-byte padding boundary.
  for (n, hex) in [
    (0, "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"),
    (111, "fa9121c7b32b9e01733d034cfc78cbf67f926c7ed83e82200ef86818196921760b4beff48404df811b953828274461673c68d04e297b0eb7b2b4d60fc6b566a2"),
    (112, "c01d080efd492776a1c43bd23dd99d0a2e626d481e16782e75d54c2503b5dc32bd05f0f1ba33e568b88fd2d970929b719ecbb152f58f130a407c8830604b70ca"),
    (128, "b73d1929aa615934e61a871596b3f3b33359f42b8175602e89f7e06e5f658a243667807ed300314b95cacdd579f3e33abdfbe351909519a846d465c59582f321")] do
    expect s!"SHA-512, {n} bytes" (Sha512.hash (List.replicate n (97 : UInt8)).toByteArray == (← parse hex))
  IO.println "Lean SHA-512 passed at lengths 0, 111, 112 and 128"
  let fixture ← IO.FS.readFile "spike/r5/rfc8032.txt"
  let mut cases := 0
  for ln in fixture.trim.splitOn "\n" do
    if ln.startsWith "#" then continue
    let [id, _, k, m, s] := ln.splitOn " " | throw (IO.userError "invalid RFC fixture row")
    let key ← parse k
    let msg ← parse m
    let sig ← parse s
    expect s!"TEST {id} enrollment" (Ed25519.validKey key)
    expect s!"TEST {id} signature" (Ed25519.verify key msg sig)
    expect s!"TEST {id} flipped signature" (!Ed25519.verify key msg (flipFirst sig))
    unless msg.isEmpty do
      expect s!"TEST {id} flipped message" (!Ed25519.verify key (flipFirst msg) sig)
    cases := cases + 1
    IO.println s!"Lean Ed25519 RFC TEST {id} accepted, mutations refused"
  expect "expected exactly three vectors" (cases == 3)
  expect "identity owner" (!Ed25519.validKey (1 :: List.replicate 31 0))

end Aukora.Crypto5Tests

def main := Aukora.Crypto5Tests.run
