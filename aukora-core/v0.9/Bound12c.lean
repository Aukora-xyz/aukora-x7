import Machine

/-! Round 12c D: bound genesis. A record started this way has a 32-byte identifier,
SHA-256 of `AUKORA/R12C/record`, the initial law digest, the initial keys and a 32-byte
host value. Its first ledger head is that identifier instead of 32 zero bytes. Every
owner signature that covers the current head (threshold, timed approval, cancel, signed
control, halt, clear, the ff02 key change, the extension forms, the seal) is therefore
tied to this record. No frame format and no admission rule changes. The old genesis
(`Core9.genesis`, head zero) is unchanged. -/

namespace Aukora.Bound12c

/-- Raw ASCII, no length prefix and no terminator. -/
def recordTag : ByteArray := "AUKORA/R12C/record".toUTF8

/-- `keys` is the 32-byte Ed25519 key followed by the 1,952-byte ML-DSA-65 key. -/
def descriptor (law keys host : ByteArray) : ByteArray := recordTag ++ law ++ keys ++ host

/-- The record identifier as the 32 raw digest bytes. -/
def identifier (law keys host : ByteArray) : Bytes := Sha256.hash (descriptor law keys host)

def seed (id : Bytes) (s : Policy9.Machine) : Policy9.Machine :=
  {s with base.hybrid.inner.ledger.head := ⟨id⟩}

/-- The model's bound genesis. Law digest and host value are exactly 32 bytes each. -/
def genesis (law keys host : ByteArray) : Option Policy9.Machine :=
  if law.size = 32 ∧ host.size = 32 then (Core9.genesis keys).map (seed (identifier law keys host)) else none

@[export r12c_bound_genesis] def boundGenesis (law keys host : ByteArray) : Option Policy9.Machine :=
  genesis law keys host

@[export r12c_record_identifier] def identifierBytes (law keys host : ByteArray) : ByteArray :=
  (identifier law keys host).toByteArray

theorem genesis_head {law keys host s} (ok : genesis law keys host = some s) :
    s.base.hybrid.inner.ledger.head = ⟨identifier law keys host⟩ := by
  unfold genesis at ok
  split at ok
  · obtain ⟨b,_,rfl⟩ := Option.map_eq_some'.mp ok
    rfl
  · contradiction

/-- Apart from the head, a bound start is an ordinary start for the same keys. -/
theorem genesis_old {law keys host s} (ok : genesis law keys host = some s) :
    ∃ b, Core9.genesis keys = some b ∧ s = seed (identifier law keys host) b := by
  unfold genesis at ok
  split at ok
  · obtain ⟨b,hit,rfl⟩ := Option.map_eq_some'.mp ok
    exact ⟨b,hit,rfl⟩
  · contradiction

#print axioms genesis_head
#print axioms genesis_old
end Aukora.Bound12c
