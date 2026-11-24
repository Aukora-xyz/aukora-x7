import Policy
import Gate

namespace Aukora.Core9
open R6.KernelCell (Context)
open Policy9 (Machine)

@[export r9_genesis] def genesis := Policy9.genesis

@[export r9_step]
def step (ctx : Context) (bytes : ByteArray) (s : Machine) : Option Machine := do
  if bytes[0]? != some 27 then Policy9.step bytes s else
    let u ← Upgrade9.decode bytes
    guard (Policy9.grantOK s u.intent)
    let hybrid ← Upgrade9.install ctx bytes s.base.hybrid u
    return {s with base := {s.base with hybrid, record := s.base.record.push bytes}}

/-- A submission through the public entry point spends a currently eligible grant
    and uses the same package and staged file as the declaration checker. -/
theorem package_admission {ctx} {bytes : ByteArray} {s t : Machine}
    (tag : bytes[0]? = some (27 : UInt8)) (h : step ctx bytes s = some t) :
    ∃ u, Upgrade9.decode bytes = some u ∧ Policy9.grantOK s u.intent = true ∧
      Upgrade9.install ctx bytes s.base.hybrid u = some t.base.hybrid ∧
      t.rules = s.rules ∧ t.outcomes = s.outcomes ∧ t.base.record = s.base.record.push bytes := by
  cases dec : Upgrade9.decode bytes with
  | none => simp [step, guard, tag, dec] at h
  | some u =>
    by_cases ok : Policy9.grantOK s u.intent = true
    · cases installed : Upgrade9.install ctx bytes s.base.hybrid u with
      | none => simp [step, guard, tag, dec, ok, installed] at h
      | some hybrid =>
        have eq : ({s with base := {s.base with hybrid, record := s.base.record.push bytes}} : Machine) = t := by
          simpa [step, guard, tag, dec, ok, installed] using h
        subst t
        exact ⟨u, rfl, ok, installed, rfl, rfl, rfl⟩
    · simp [step, guard, tag, dec, ok] at h
      contradiction

#print axioms package_admission

@[export r9_feed] def feed (chunk : ByteArray) (s : Machine) : Machine :=
  {s with base := Core8.feed chunk s.base}
@[export r9_reset] def reset (s : Machine) : Machine :=
  {s with base := Core8.reset s.base}
@[export r9_stamp] def stamp (bytes : ByteArray) (s : Machine) : Option Machine :=
  (Core8.stamp bytes s.base).map fun base => {s with base}

@[export r9_head_byte] def headByte (s : Machine) (index : UInt32) := Core8.headByte s.base index
@[export r9_core_byte] def coreByte (s : Machine) (index : UInt32) := Core8.coreByte s.base index
@[export r9_threshold] def threshold (s : Machine) := Core8.threshold s.base
@[export r9_record_byte] def recordByte (s : Machine) (entry offset : UInt32) :=
  Core8.recordByte s.base entry offset
@[export r9_stamp_count] def stampCount (s : Machine) := Core8.stampCount s.base
@[export r9_stamp_byte] def stampByte (s : Machine) (entry offset : UInt32) :=
  Core8.stampByte s.base entry offset
@[export r9_outcome] def outcome (s : Machine) (key : ByteArray) := Policy9.outcomeCode s key
end Aukora.Core9
