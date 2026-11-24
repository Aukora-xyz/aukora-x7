import core.Core
import core.Sha256

/- Round 3 envelope encoding. The header is a 32-byte parent, a little-endian u16
   sequence, and a one-byte event tag in Core.Event declaration order. Every Nat
   and every text/blob byte count is u16 little-endian. Text is strict UTF-8;
   install digests are fixed at 32 bytes. Fields follow constructor order.
   Bool, Result and Body are one-byte tags; alternative numbering starts at zero. -/
namespace Aukora.Stateful

private abbrev Reader := StateT Bytes Option
private def invalid {α : Type} : Reader α := fun _ => none

private def byte : Reader UInt8
  | [] => none
  | b :: rest => some (b, rest)

private def u16 : Reader Nat := do
  let low ← byte
  let high ← byte
  return low.toNat + 256 * high.toNat

private def takeBytes (n : Nat) : Reader Bytes := go n []
where
  go : Nat → Bytes → Bytes → Option (Bytes × Bytes)
    | 0, acc, rest => some (acc.reverse, rest)
    | _+1, _, [] => none
    | k+1, acc, b::bs => go k (b::acc) bs

private def blob : Reader Bytes := do takeBytes (← u16)
private def digestField : Reader Digest := do return ⟨← takeBytes 32⟩

private def textField : Reader String := do
  let bytes ← blob
  match String.fromUTF8? bytes.toByteArray with
  | none => invalid
  | some s => return s

private def boolField : Reader Bool := do
  match (← byte).toNat with
  | 0 => return false
  | 1 => return true
  | _ => invalid

private def resultField : Reader Result := do
  match (← byte).toNat with
  | 0 => return .confirmed
  | 1 => return .failed
  | 2 => return .unknown
  | _ => invalid

private def bodyField : Reader Body := do
  match (← byte).toNat with
  | 0 => return .deliver (← blob)
  | 1 => return .install (← digestField)
  | _ => invalid

private def intentField : Reader Intent := do
  return ⟨← bodyField, ← textField, ← u16, ← u16⟩

private def eventField : Reader Event := do
  match (← byte).toNat with
  | 0 => return .say (← textField)
  | 1 => return .remember (← u16) (← u16) (← textField)
  | 2 => return .correct (← u16) (← u16) (← textField)
  | 3 => return .grant (← intentField) (← boolField)
  | 4 => return .act (← intentField)
  | 5 => return .outcome (← intentField) (← resultField)
  | 6 => return .advise (← textField) (← u16)
  | 7 => return .upgrade (← digestField) (← boolField) (← intentField)
  | 8 => return .rebind (← textField) (← boolField)
  | _ => invalid

private def envelopeField : Reader Envelope := do
  return ⟨← digestField, ← u16, ← eventField⟩

def decode (wire : ByteArray) : Option Envelope :=
  match envelopeField wire.toList with
  | some (e, []) => some e
  | _ => none

private def putU16 (n : Nat) : Bytes :=
  let v := n.toUInt16
  [v.toUInt8, (v >>> 8).toUInt8]

private def putBlob (xs : Bytes) := putU16 xs.length ++ xs
private def putText (s : String) := putBlob s.toUTF8.toList

private def putIntent (i : Intent) : Bytes :=
  let body := match i.body with
    | .deliver xs => 0 :: putBlob xs
    | .install d => 1 :: d.bytes
  body ++ putText i.audience ++ putU16 i.generation ++ putU16 i.nonce

private def putEvent : Event → Bytes
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

def encode (e : Envelope) : Bytes := e.parent.bytes ++ putU16 e.seq ++ putEvent e.event

def envelopeDigest (e : Envelope) : Digest := ⟨Sha256.hash (encode e).toByteArray⟩

@[export r3_genesis]
def initial (_ : UInt8) : State :=
  let zero : Digest := ⟨List.replicate 32 0⟩
  genesis zero zero "owner"

@[export r3_step]
def stepBytes (wire : @& ByteArray) (s : @& State) : Option State := do
  let e ← decode wire
  next envelopeDigest s e

@[export r3_head_byte]
def headByte (s : @& State) (index : UInt32) : UInt8 :=
  s.head.bytes.getD index.toNat 0

theorem step_decoded (s : State) (wire : ByteArray) (e : Envelope) (h : decode wire = some e) :
    stepBytes wire s = next envelopeDigest s e := by simp [stepBytes, h]

theorem step_malformed (s : State) (wire : ByteArray) (h : decode wire = none) :
    stepBytes wire s = none := by simp [stepBytes, h]

#print axioms step_decoded
#print axioms step_malformed

end Aukora.Stateful
