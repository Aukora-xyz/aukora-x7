import ReleaseInterface
import Compatibility.LegacyCandidate

namespace Aukora.Release
open R6.KernelCell (Context)

-- The earlier public API knew only the Ed key and the inner ledger. Embed exactly
-- those two parts. Newer views have empty initial data and no stamp/lookup operation.
private def liftLegacy (old : Bound5.Machine) : State :=
  { base := ⟨⟨old.inner, ⟨old.ownerKey, []⟩⟩, Risk8.initial, #[], #[]⟩ }

private def legacyStep (ctx : Context) (w : ByteArray) (s : State) : Option State :=
  (Upgrade6.step ctx w (Hybrid7.edView s.base.hybrid)).map liftLegacy

/-- Project the historical fixed-Ed25519 implementation onto the common state
    schema. Grant, rebind and owner-control decisions run its original step. -/
def edOnly : Model where
  step := legacyStep
  genesis := fun _ => (Bound5.genesis R9Candidate.ownerKey.toByteArray).map liftLegacy
  feed := fun chunk s => liftLegacy (Bound5.feed chunk (Hybrid7.edView s.base.hybrid))
  reset := fun s => liftLegacy (Bound5.reset (Hybrid7.edView s.base.hybrid))
  stamp := fun _ _ => none
  outcome := fun _ _ => 256

def legacyStart : State := liftLegacy (Bound5.initial R9Candidate.ownerKey)

set_option maxRecDepth 8192 in
theorem legacyStartReachable (input : ByteArray) : edOnly.genesis input = some legacyStart := by
  have valid : Ed25519.validKey R9Candidate.ownerKey = true := by decide +kernel
  change ((if Ed25519.validKey R9Candidate.ownerKey = true then some (Bound5.initial R9Candidate.ownerKey)
            else none).map liftLegacy) = some legacyStart
  rw [if_pos valid]
  rfl

theorem projectedLegacyStep (ctx : Context) (w : ByteArray) (s : State) :
    edOnly.step ctx w s = ((R9Candidate.honest ctx).step w (Hybrid7.edView s.base.hybrid)).map liftLegacy := rfl

/-- The exact installation intent signed in the archived fixed-owner test. -/
def legacyIntent : Intent := ⟨.install ⟨[
    0x49, 0x7d, 0x49, 0x3c, 0x8c, 0xf6, 0xc6, 0xf1,
    0xfc, 0xb2, 0x51, 0x7b, 0x72, 0x1c, 0xb1, 0xc1,
    0x2f, 0x25, 0x44, 0x6f, 0x8f, 0x85, 0xa9, 0x1d,
    0x64, 0x34, 0x44, 0x7b, 0x95, 0xf0, 0xb6, 0x49]⟩, "core", 0, 1⟩

def legacySignature : Bytes := [
    0xae, 0xc5, 0x27, 0x79, 0xe5, 0x77, 0x67, 0x2b,
    0x8b, 0xd3, 0x45, 0x86, 0xc6, 0x02, 0x6e, 0x02,
    0x4a, 0x2b, 0xbb, 0x56, 0x32, 0x8f, 0x96, 0xd6,
    0x5d, 0x3f, 0x86, 0x63, 0x96, 0x15, 0xde, 0x81,
    0xa7, 0x82, 0xe7, 0xa6, 0x1b, 0xb0, 0x66, 0x7f,
    0x01, 0xb4, 0x4b, 0xb2, 0xe8, 0x9c, 0xc1, 0x56,
    0x51, 0x8c, 0x4c, 0x7d, 0x02, 0xe5, 0x4e, 0xad,
    0x07, 0x7d, 0x99, 0x26, 0x8d, 0xae, 0xda, 0x0f]

def legacyGrant : ByteArray :=
  (Wire5.encode ⟨⟨List.replicate 32 0⟩, 1, .grant legacyIntent legacySignature⟩).toByteArray

set_option maxRecDepth 8192 in
theorem legacyGrantNoCommand : Policy9.decode legacyGrant = none := by rfl

end Aukora.Release
