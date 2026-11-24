import Compatibility.Certificate
import Proofs.Wire

namespace Aukora.Tag9
open private Wire4.data_bytes from Proofs.Wire

def eventTag : Event → UInt8
  | .say .. => 0 | .remember .. => 1 | .correct .. => 2 | .grant .. => 3
  | .act .. => 4 | .outcome .. => 5 | .advise .. => 6 | .upgrade .. => 7 | .rebind .. => 8

def actionTag : R2.Action → UInt8
  | .base e => eventTag e | .retract .. => 9 | .mandate .. => 10 | .useMandate .. => 11
  | .grantBudget .. => 12 | .spend .. => 13 | .pass .. => 14 | .revoke .. => 15 | .read .. => 16

private theorem put_width (width n : Nat) : (Wire4.putUInt width n).length = width := by
  induction width generalizing n with
  | zero => rfl
  | succ k ih => simp [Wire4.putUInt, ih]

private theorem event_tag (e : Event) : (Wire4.putEvent e).head? = some (eventTag e) := by
  cases e <;> rfl

private theorem action_tag (a : R2.Action) : (Wire4.putAction a).head? = some (actionTag a) := by
  cases a <;> first | apply event_tag | rfl

private theorem payload_tag (a : Wire5.Action) :
    (Wire5.putAction a).head? = some (actionTag a.project) := by
  cases a with
  | plain op => exact action_tag op
  | grant _ _ => rfl
  | rebind _ _ => rfl
  | control op sig =>
    cases op <;> simp [Wire5.putAction, Wire5.controlFields, Wire5.Control.project, Wire5.Action.project,
      Wire4.putAction, actionTag, List.head?_append] <;>
      left <;> simp [List.head?_dropLast]

/-- Byte 40 of every emitted ordinary wire with a 32-byte parent is its
constructor's tag, independent of sequence, signatures and all payload bytes. -/
theorem encode_tag (frame : Wire5.Frame) (parent : frame.parent.bytes.length = 32) :
    (Wire5.encode frame)[40]? = some (actionTag frame.action.project) := by
  have header : (Wire5.header frame).length = 40 := by simp [Wire5.header, put_width, parent]
  rw [Wire5.encode, List.getElem?_append_right (by omega : (Wire5.header frame).length ≤ 40), header]
  simpa [List.head?_eq_getElem?] using payload_tag frame.action

private theorem tag_of_elem {w : ByteArray} {v : UInt8} (h : w.data.toList[40]? = some v) :
    Upgrade6.tag w = v := by
  cases w with | mk a =>
  simp only [Array.getElem?_toList] at h
  unfold Upgrade6.tag
  obtain ⟨valid, eq⟩ := Array.getElem?_eq_some_iff.mp h
  rw [dif_pos (show 40 < (ByteArray.mk a).size from valid)]
  exact eq

theorem gate_reads_tag (frame : Wire5.Frame) (parent : frame.parent.bytes.length = 32) :
    Upgrade6.tag (Wire5.encode frame).toByteArray = actionTag frame.action.project := by
  apply tag_of_elem
  rw [Wire4.data_bytes]
  exact encode_tag frame parent

/-- This excludes precisely the retired Boolean-flag upgrade constructor. -/
def legacyUpgrade : R2.Action → Bool
  | .base (.upgrade ..) => true
  | _ => false

theorem ordinary_not_caught (frame : Wire5.Frame) (parent : frame.parent.bytes.length = 32)
    (ordinary : legacyUpgrade frame.action.project = false) :
    Upgrade6.tag (Wire5.encode frame).toByteArray ≠ 7 ∧
    Upgrade6.tag (Wire5.encode frame).toByteArray ≠ 17 ∧
    Upgrade6.tag (Wire5.encode frame).toByteArray ≠ 18 := by
  rw [gate_reads_tag frame parent]
  generalize frame.action.project = a at ordinary ⊢
  cases a <;> simp [actionTag]
  case base e => cases e <;> simp [legacyUpgrade, eventTag] at *

/-- The raw encoder also accepts an arbitrary-length Digest. With 33 parent bytes,
byte 40 is the high sequence byte (7 here), even though the supplied event is say. -/
theorem malformed_parent_counterexample :
    let f : Wire5.Frame := ⟨⟨List.replicate 33 0⟩, 7 * 256^7, .plain (.base (.say ""))⟩
    Upgrade6.tag (Wire5.encode f).toByteArray = 7 ∧ actionTag f.action.project = 0 := by decide

#print axioms encode_tag
#print axioms gate_reads_tag
#print axioms ordinary_not_caught
#print axioms malformed_parent_counterexample
end Aukora.Tag9
