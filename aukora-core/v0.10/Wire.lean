import Ledger.Frames

/- R4 wire format. A frame starts with its 32-byte parent and eight-byte LE
sequence. Other numbers and byte counts are two-byte LE. Base event tags 0..8
and their payloads retain the R3 layout. Tags 9..16 follow the R2 Action
constructors after `base`. A useMandate contains one tagged base event. -/
namespace Aukora.Wire4

abbrev Reader := StateT Bytes Option

def invalid {α : Type} : Reader α := fun _ => none

def byte : Reader UInt8
  | [] => none
  | b :: rest => some (b, rest)

def uint : Nat → Reader Nat
  | 0 => pure 0
  | width + 1 => do
    let low ← byte
    return low.toNat + 256 * (← uint width)

def putUInt : Nat → Nat → Bytes
  | 0, _ => []
  | width + 1, n => UInt8.ofNat n :: putUInt width (n / 256)

abbrev u16 := uint 2
abbrev putU16 := putUInt 2

def takeBytes (n : Nat) (xs : Bytes) : Option (Bytes × Bytes) :=
  let first := xs.take n
  if first.length = n then some (first, xs.drop n) else none

def blob : Reader Bytes := do takeBytes (← u16)
def putBlob (xs : Bytes) : Bytes := putU16 xs.length ++ xs

def digestField : Reader Digest := do return ⟨← takeBytes 32⟩

/-- RFC 3629 UTF-8. The scalar validity check rejects surrogate and out-of-range
values. Minimum values reject overlong encodings, including noncanonical NUL. -/
def continuation : Reader Nat := do
  let b := (← byte).toNat
  if 128 ≤ b ∧ b < 192 then return b - 128 else invalid

def scalar (min n : Nat) : Reader Char :=
  let c := Char.ofNat n
  if min ≤ n ∧ c.toNat = n then pure c else invalid

def readChar : Reader Char := do
  let lead := (← byte).toNat
  if lead < 128 then return Char.ofNat lead
  else if lead < 192 then invalid
  else if lead < 224 then scalar 128 (64 * (lead - 192) + (← continuation))
  else if lead < 240 then
    let acc := 64 * (lead - 224) + (← continuation)
    scalar 2048 (64 * acc + (← continuation))
  else if lead < 248 then
    let acc := 64 * (lead - 240) + (← continuation)
    let acc := 64 * acc + (← continuation)
    scalar 65536 (64 * acc + (← continuation))
  else invalid

def contByte (n : Nat) := UInt8.ofNat (128 + n % 64)

def putChar (c : Char) : Bytes :=
  let n := c.toNat
  if n < 128 then [UInt8.ofNat n]
  else if n < 2048 then [UInt8.ofNat (192 + n / 64), contByte n]
  else if n < 65536 then [UInt8.ofNat (224 + n / 4096), contByte (n / 64), contByte n]
  else [UInt8.ofNat (240 + n / 262144), contByte (n / 4096), contByte (n / 64), contByte n]

def textLoop : Nat → Bytes → List Char → Option String
  | 0, xs, acc => if xs.isEmpty then some ⟨acc.reverse⟩ else none
  | fuel + 1, xs, acc =>
    if xs.isEmpty then some ⟨acc.reverse⟩ else
      match readChar xs with
      | none => none
      | some (c, rest) => textLoop fuel rest (c :: acc)

def textField : Reader String := do
  let bytes ← blob
  match textLoop bytes.length bytes [] with
  | none => invalid
  | some s => return s

def textBytes (s : String) : Bytes := s.data.flatMap putChar
def putText (s : String) : Bytes := putBlob (textBytes s)

def boolField : Reader Bool := do
  match (← byte).toNat with
  | 0 => return false
  | 1 => return true
  | _ => invalid

def resultField : Reader Result := do
  match (← byte).toNat with
  | 0 => return .confirmed
  | 1 => return .failed
  | 2 => return .unknown
  | _ => invalid

def bodyField : Reader Body := do
  match (← byte).toNat with
  | 0 => return .deliver (← blob)
  | 1 => return .install (← digestField)
  | _ => invalid

def intentField : Reader Intent := do
  return ⟨← bodyField, ← textField, ← u16, ← u16⟩

def baseFields : Nat → Reader Event
  | 0 => do return .say (← textField)
  | 1 => do return .remember (← u16) (← u16) (← textField)
  | 2 => do return .correct (← u16) (← u16) (← textField)
  | 3 => do return .grant (← intentField) (← boolField)
  | 4 => do return .act (← intentField)
  | 5 => do return .outcome (← intentField) (← resultField)
  | 6 => do return .advise (← textField) (← u16)
  | 7 => do return .upgrade (← digestField) (← boolField) (← intentField)
  | 8 => do return .rebind (← textField) (← boolField)
  | _ => invalid

def actionField : Reader R2.Action := do
  let tag := (← byte).toNat
  match tag with
  | 9 => return .retract (← u16) (← boolField)
  | 10 => return .mandate ⟨← textField, ← blob, ← u16, ← u16, ← u16⟩ (← boolField)
  | 11 => return .useMandate (← u16) (← baseFields (← byte).toNat)
  | 12 => return .grantBudget ⟨← u16, ← u16⟩ (← boolField)
  | 13 => return .spend (← u16) (← u16)
  | 14 => return .pass ⟨← textField, ← textField, ← u16, ← u16⟩ (← boolField)
  | 15 => return .revoke (← u16) (← boolField)
  | 16 => return .read (← u16) (← textField) (← textField) (← boolField)
  | other => return .base (← baseFields other)

def frameField : Reader R2.Frame := do
  return ⟨← digestField, ← uint 8, ← actionField⟩

def decode (wire : ByteArray) : Option R2.Frame :=
  match frameField wire.data.toList with
  | some (x, []) => some x
  | _ => none

def putBody : Body → Bytes
  | .deliver xs => 0 :: putBlob xs
  | .install d => 1 :: d.bytes

def putIntent (i : Intent) : Bytes :=
  putBody i.body ++ putText i.audience ++ putU16 i.generation ++ putU16 i.nonce

def putEvent : Event → Bytes
  | .say s => 0 :: putText s
  | .remember id src s => 1 :: (putU16 id ++ putU16 src ++ putText s)
  | .correct old repl s => 2 :: (putU16 old ++ putU16 repl ++ putText s)
  | .grant i v => 3 :: (putIntent i ++ [v.toUInt8])
  | .act i => 4 :: putIntent i
  | .outcome i r =>
    let tag : UInt8 := match r with | .confirmed => 0 | .failed => 1 | .unknown => 2
    5 :: (putIntent i ++ [tag])
  | .advise s n => 6 :: (putText s ++ putU16 n)
  | .upgrade d checked i => 7 :: (d.bytes ++ (checked.toUInt8 :: putIntent i))
  | .rebind owner verified => 8 :: (putText owner ++ [verified.toUInt8])

def putAction : R2.Action → Bytes
  | .base e => putEvent e
  | .retract n ok => 9 :: (putU16 n ++ [ok.toUInt8])
  | .mandate m ok => 10 :: (putText m.audience ++ putBlob m.payload ++ putU16 m.generation ++
      putU16 m.count ++ putU16 m.expiry ++ [ok.toUInt8])
  | .useMandate id op => 11 :: (putU16 id ++ putEvent op)
  | .grantBudget b ok => 12 :: (putU16 b.generation ++ putU16 b.cap ++ [ok.toUInt8])
  | .spend id n => 13 :: (putU16 id ++ putU16 n)
  | .pass p ok => 14 :: (putText p.reader ++ putText p.scope ++ putU16 p.generation ++ putU16 p.expiry ++ [ok.toUInt8])
  | .revoke id ok => 15 :: (putU16 id ++ [ok.toUInt8])
  | .read id reader scope ok => 16 :: (putU16 id ++ putText reader ++ putText scope ++ [ok.toUInt8])

def encode (x : R2.Frame) : Bytes := x.parent.bytes ++ putUInt 8 x.seq ++ putAction x.action

end Aukora.Wire4
