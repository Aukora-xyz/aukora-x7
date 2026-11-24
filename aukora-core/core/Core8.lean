import core.Hybrid7
import core.Mldsa8
import core.Risk8

namespace Aukora.Core8

open R6.KernelCell (Context)

def verifiers : Hybrid7.Verifiers :=
  ⟨Ed25519.verify, fun key message signature =>
    Mldsa8.verify key.toByteArray message.toByteArray signature.toByteArray⟩

private def slice (data : ByteArray) (first last : Nat) : Bytes :=
  (data.extract first last).data.toList

structure Machine where
  hybrid : Hybrid7.Machine
  risk : Risk8.State
  record : Array ByteArray
  stamps : Array ByteArray

@[export r8_genesis]
def genesis (keys : ByteArray) : Option Machine := do
  guard (keys.size == 32 + 1952)
  let hybrid ← Hybrid7.genesis ⟨slice keys 0 32, slice keys 32 keys.size⟩
  return ⟨hybrid, Risk8.initial, #[], #[]⟩

/-- The prefix is exactly the serialization hashed by `Hybrid7.reqDigest`.
    Inside it, `Upgrade7.decode` requires the entire legacy wire to parse. -/
def request (bytes : ByteArray) : Option Hybrid7.Request := do
  let tag : UInt8 ← bytes[0]?
  match tag with
  | 0 => return ⟨bytes.extract 1 bytes.size, .unsigned⟩
  | 19 =>
    let body := 1 + 3309
    guard (body ≤ bytes.size)
    return ⟨bytes.extract body bytes.size, .signed (slice bytes 1 body)⟩
  | 20 =>
    let sig := 1 + 1952
    let body := sig + 3309
    guard (body ≤ bytes.size)
    return ⟨bytes.extract body bytes.size, .binding (slice bytes 1 sig) (slice bytes sig body)⟩
  | _ => none

private def headerFields : Wire4.Reader (Digest × Nat) := do
  return (← Wire4.digestField, ← Wire4.uint 8)

private def header (bytes : ByteArray) : Option (Digest × Nat) := do
  let (fields, []) ← headerFields (slice bytes 1 41) | none
  return fields

private def append (s : Machine) (wire : ByteArray) (action : R2.Frame) : Option Hybrid7.Machine := do
  let inner ← Bound4.next (fun _ => Bound4.digest wire) s.hybrid.inner action
  return {s.hybrid with inner}

-- Each metadata event occupies one legacy ledger position without issuing a capability.
-- The public record keeps its actual bytes, including the bundle and any signatures.
private def metadata (s : Machine) (wire : ByteArray) (parent : Digest) (seq : Nat)
    (label : String) (value : UInt8) (risk : Risk8.State) : Option Machine := do
  let hybrid ← append s wire ⟨parent, seq, .base (.advise label value.toNat)⟩
  return {s with hybrid, risk}

private def assessment (bytes : ByteArray) (s : Machine) : Option Machine := do
  guard (bytes.size == 106)
  let (parent, seq) ← header bytes
  let key := Digest.mk (slice bytes 41 73)
  let score : UInt8 ← bytes[73]?
  let bundle := Digest.mk (slice bytes 74 106)
  metadata s bytes parent seq "AUKORA/R8/assess" score (Risk8.assess s.risk key score bundle)

private def thresholdControl (bytes : ByteArray) (s : Machine) : Option Machine := do
  guard (bytes.size == 106 + 3309)
  let (parent, seq) ← header bytes
  let level : UInt8 ← bytes[41]?
  let gen := Hybrid7.generation s.hybrid
  guard (gen < 2^64)
  let risk ← Risk8.setThreshold verifiers s.hybrid.owner gen parent seq level
    (slice bytes 42 106) (slice bytes 106 bytes.size) s.risk
  metadata s bytes parent seq "AUKORA/R8/threshold" level risk

private def actRoute (x : Wire5.Frame) : Option (Intent × Bool) :=
  match x.action with
  | .plain (.base (.act i)) => some (i, true)
  | .plain (.useMandate _ (.act i)) => some (i, false)
  | _ => none

private def act (bytes : ByteArray) (s : Machine) : Option Machine := do
  guard (33 ≤ bytes.size)
  let bundle := Digest.mk (slice bytes 1 33)
  let x ← Wire5.decode (bytes.extract 33 bytes.size)
  let (intent, useGrant) ← actRoute x
  -- The legacy ledger validates and consumes the selected credential. Commit its
  -- successor only when the risk policy also accepts the exact bundle and route.
  let hybrid ← append s bytes x.project
  let risk ← Risk8.act s.risk (Risk8.intentDigest intent) bundle useGrant (!useGrant)
  return {s with hybrid, risk}

private def dispatch (primary other : Context) (bytes : ByteArray) (s : Machine) : Option Machine := do
  let tag : UInt8 ← bytes[0]?
  match tag with
  | 21 => assessment bytes s
  | 22 => thresholdControl bytes s
  | 23 => act bytes s
  | _ =>
    let r ← request bytes
    -- The legacy direct/mandate act tags cannot supply a bundle digest.
    guard (Upgrade6.tag r.wire != 4 && Upgrade6.tag r.wire != 11)
    let hybrid ← Hybrid7.step verifiers primary other r s.hybrid
    return {s with hybrid}

@[export r8_step]
def step (primary other : Context) (bytes : ByteArray) (s : Machine) : Option Machine := do
  let next ← dispatch primary other bytes s
  return {next with record := s.record.push bytes}

@[export r8_feed]
def feed (chunk : ByteArray) (s : Machine) : Machine := {s with hybrid := Hybrid7.feed chunk s.hybrid}

@[export r8_reset]
def reset (s : Machine) : Machine := {s with hybrid := Hybrid7.reset s.hybrid}

@[export r8_head_byte]
def headByte (s : Machine) (index : UInt32) : Nat :=
  (Bound4.headByte s.hybrid.inner index).toNat

@[export r8_core_byte]
def coreByte (s : Machine) (index : UInt32) : Nat :=
  (Bound4.coreByte s.hybrid.inner index).toNat

@[export r8_threshold]
def threshold (s : Machine) : Nat := s.risk.threshold.toNat

private def readByte (history : Array ByteArray) (entry offset : UInt32) : Nat :=
  let found : Option UInt8 := do
    let wire ← history[entry.toNat]?
    wire[offset.toNat]?
  (found.map UInt8.toNat).getD 256

@[export r8_record_byte]
def recordByte (s : Machine) (entry offset : UInt32) : Nat := readByte s.record entry offset

/-- A stamp holds a u16-length beacon value and a 32-byte receipt digest for
    the current head. External verifiers must interpret both opaque fields. -/
def decodeStamp (wire : ByteArray) : Option (Digest × ByteArray × Digest) := do
  guard (66 ≤ wire.size)
  let lo : UInt8 ← wire[32]?
  let hi : UInt8 ← wire[33]?
  let endBeacon := 34 + lo.toNat + 256 * hi.toNat
  guard (wire.size == endBeacon + 32)
  return (⟨slice wire 0 32⟩, wire.extract 34 endBeacon, ⟨slice wire endBeacon wire.size⟩)

@[export r8_stamp]
def stamp (bytes : ByteArray) (s : Machine) : Option Machine := do
  let (parent, _, _) ← decodeStamp bytes
  guard (parent = s.hybrid.inner.ledger.head)
  return {s with stamps := s.stamps.push bytes}

@[export r8_stamp_count]
def stampCount (s : Machine) : Nat := s.stamps.size

@[export r8_stamp_byte]
def stampByte (s : Machine) (entry offset : UInt32) : Nat := readByte s.stamps entry offset

/-- Read-only benchmark for the exact request decoder and consensus head hash.
    Returning a byte forces evaluation of the complete digest. -/
@[export r8_hash_head]
def hashHead (bytes : ByteArray) : Nat :=
  match request bytes with
  | none => 256
  | some r => ((Hybrid7.reqDigest r).bytes.headD 0).toNat

end Aukora.Core8
