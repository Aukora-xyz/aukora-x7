import Checker
import ModelSection
import Hybrid

namespace Aukora.Upgrade9

open R6.KernelCell (Context)

structure Package where
  parent : Digest
  seq : Nat
  target : Digest
  model : ByteArray
  proof : ByteArray
  intent : Intent

def maxCertificate := 1024*1024

private def header : Wire4.Reader (Digest × Nat × Digest × Nat) := do
  return (← Wire4.digestField, ← Wire4.uint 8, ← Wire4.digestField, ← Wire4.uint 4)

/-- Outer tag 27. The digest and both length fields are covered by the ledger head.
    The hybrid installation grant binds the target, which includes the custom section. -/
def decode (wire : ByteArray) : Option Package := do
  guard (wire[0]? == some 27)
  let ((parent, seq, target, m), []) ← header (wire.extract 1 77).data.toList | none
  guard (0 < m && m ≤ maxCertificate && 81 + m ≤ wire.size)
  let (p, []) ← Wire4.uint 4 (wire.extract (77+m) (81+m)).data.toList | none
  guard (0 < p && m+p ≤ maxCertificate && 81+m+p < wire.size)
  let (i, []) ← Wire4.intentField (wire.extract (81+m+p) wire.size).data.toList | none
  return ⟨parent, seq, target, wire.extract 77 (77+m), wire.extract (81+m) (81+m+p), i⟩

def frame (u : Package) : R2.Frame :=
  ⟨u.parent, u.seq, .base (.upgrade u.target true u.intent)⟩

/-- Both byte lengths use the existing tag-1b little-endian width. The ASCII audience
    travels inside the signed intent in both grant formats. -/
def packageAudience (model proof : ByteArray) : String :=
  let message := "AUKORA/R12/package".toUTF8 ++ (Wire4.putUInt 4 model.size).toByteArray ++ model ++
    (Wire4.putUInt 4 proof.size).toByteArray ++ proof
  "core/r12/" ++ Wire5.keyName (Sha256.hash message)

def ownerBound (u : Package) : Bool := u.intent.audience == packageAudience u.model u.proof

def install (ctx : Context) (wire : ByteArray) (s : Hybrid7.Machine) (u : Package) :
    Option Hybrid7.Machine := do
  guard (ModelSection9.read s.inner.candidate = some (Bound4.digest u.model))
  guard (Checker9.check ctx u.model u.proof)
  let inner ← Bound4.next (fun _ => Bound4.digest wire) s.inner (frame u)
  return {s with inner}

private theorem install_ok {ctx wire s u t} (ok : install ctx wire s u = some t) :
    ModelSection9.read s.inner.candidate = some (Bound4.digest u.model) ∧
    Checker9.check ctx u.model u.proof = true ∧
    Bound4.next (fun _ => Bound4.digest wire) s.inner (frame u) = some t.inner := by
  by_cases commitment : ModelSection9.read s.inner.candidate = some (Bound4.digest u.model)
  · by_cases check : Checker9.check ctx u.model u.proof = true
    · cases hn : Bound4.next (fun _ => Bound4.digest wire) s.inner (frame u) with
      | none => simp [install, guard, commitment, check, hn] at ok
      | some inner =>
        have eq : ({s with inner} : Hybrid7.Machine) = t := by
          simpa [install, guard, commitment, check, hn] using ok
        subst t
        exact ⟨commitment, check, rfl⟩
    · simp [install, guard, commitment, check] at ok
      contradiction
  · simp [install, guard, commitment] at ok
    contradiction

/-- The same staged bytes determine the model commitment and the approved target.
    This theorem establishes which predicates ran on admission. -/
theorem admission {ctx wire s u t} (ok : install ctx wire s u = some t) :
    ModelSection9.read s.inner.candidate = some (Bound4.digest u.model) ∧
    Checker9.check ctx u.model u.proof = true ∧
    Bound4.digest s.inner.candidate = u.target ∧
    t.inner.ledger.book.auth.core = Bound4.digest s.inner.candidate ∧
    u.intent.body = .install (Bound4.digest s.inner.candidate) ∧
    u.intent ∈ s.inner.ledger.book.auth.grants ∧ u.intent ∉ t.inner.ledger.book.auth.grants := by
  obtain ⟨commitment, checked, hn⟩ := install_ok ok
  have staged : Bound4.digest s.inner.candidate = u.target := by
    simpa [frame, Bound4.candidateOK] using (Bound4.accepted hn).1
  obtain ⟨_, body, grant, _, target, spent⟩ :=
    Bound4.upgrade_facts (target := u.target) (checked := true) (i := u.intent) hn rfl
  exact ⟨commitment, checked, staged, target, body, grant, spent⟩

theorem install_clocks {ctx wire s u t} (ok : install ctx wire s u = some t) :
    Hybrid7.generation t = Hybrid7.generation s ∧ t.inner.ledger.book.seq = s.inner.ledger.book.seq + 1 := by
  have hn := (install_ok ok).2.2
  have ledger := (R2.next_spec (Bound4.accepted hn).2).2
  simp [Hybrid7.generation, ledger, frame, R2.append, R2.nextBook, advance, changeAuth, spend]

#print axioms admission
#print axioms install_clocks
end Aukora.Upgrade9
