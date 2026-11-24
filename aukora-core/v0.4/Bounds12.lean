import ReleaseInterface

namespace Aukora.Bounds12
open Release
open R6.KernelCell (Context)

def maxInput := 1024 * 1024 + 2 * 65535 + 128
def maxStaged := 16 * 1024 * 1024
def maxEntries := 512
def maxRecordBytes := 2 * 1024 * 1024

def entries (s : Release.State) := s.base.record.size + s.base.stamps.size

def totalBytes (xs : Array ByteArray) := xs.foldl (fun n w => n + w.size) 0
def recordBytes (s : Release.State) := totalBytes s.base.record + totalBytes s.base.stamps

def stageSize (s : Release.State) := s.base.hybrid.inner.candidate.size

def room (s : Release.State) (w : ByteArray) : Bool :=
  decide (w.size ≤ maxInput ∧ entries s < maxEntries ∧ recordBytes s + w.size ≤ maxRecordBytes)

/-- A finite-session wrapper. The costs count the exact stored bytes including headers,
    signatures and opaque beacon data. A refused call returns no replacement state. -/
def submit (m : Model) (ctx : Context) (s : Release.State) : Input → Option Release.State
  | .frame w => if room s w then m.step ctx w s else none
  | .stamp w => if room s w then m.stamp w s else none
  | .feed b =>
    if b.size ≤ maxInput ∧ stageSize s + b.size ≤ maxStaged then some (m.feed b s) else none
  | .reset => some (m.reset s)

def apply (m : Model) (ctx : Context) (s : Release.State) (c : Input) : Release.State :=
  (submit m ctx s c).getD s

/-- The Option exhausts the mathematical outcomes. This is a statement about
    bounded submissions at the model boundary; a runtime allocator lies outside it. -/
theorem total_submission (m : Model) (ctx s c) :
    (submit m ctx s c = none ∧ apply m ctx s c = s) ∨
    ∃ t, submit m ctx s c = some t ∧ apply m ctx s c = t := by
  cases h : submit m ctx s c with
  | none => exact Or.inl ⟨rfl,by simp [apply,h]⟩
  | some t => exact Or.inr ⟨t,rfl,by simp [apply,h]⟩

theorem refused_unchanged {m ctx s c} (h : submit m ctx s c = none) : apply m ctx s c = s := by
  simp [apply,h]

theorem stage_limit (m : Model) (ctx s b) (over : maxStaged < stageSize s + b.size) :
    submit m ctx s (.feed b) = none ∧ apply m ctx s (.feed b) = s := by
  have blocked : ¬ (b.size ≤ maxInput ∧ stageSize s + b.size ≤ maxStaged) :=
    fun good => (Nat.not_lt_of_ge good.2) over
  have no : submit m ctx s (.feed b) = none := by simp [submit,blocked]
  exact ⟨no,refused_unchanged no⟩

theorem record_limit (m : Model) (ctx s w)
    (over : maxEntries ≤ entries s ∨ maxRecordBytes < recordBytes s + w.size ∨ maxInput < w.size) :
    (submit m ctx s (.frame w) = none ∧ apply m ctx s (.frame w) = s) ∧
    (submit m ctx s (.stamp w) = none ∧ apply m ctx s (.stamp w) = s) := by
  have noRoom : room s w = false := by
    simp only [room,decide_eq_false_iff_not]
    intro good
    rcases over with count | bytes | wire
    · exact (Nat.not_lt_of_ge count) good.2.1
    · exact (Nat.not_lt_of_ge good.2.2) bytes
    · exact (Nat.not_lt_of_ge good.1) wire
  have noF : submit m ctx s (.frame w) = none := by simp [submit,noRoom]
  have noS : submit m ctx s (.stamp w) = none := by simp [submit,noRoom]
  exact ⟨⟨noF,refused_unchanged noF⟩,⟨noS,refused_unchanged noS⟩⟩

theorem fits_record (m : Model) (ctx s w)
    (input : w.size ≤ maxInput) (count : entries s < maxEntries)
    (bytes : recordBytes s + w.size ≤ maxRecordBytes) :
    submit m ctx s (.frame w) = m.step ctx w s ∧ submit m ctx s (.stamp w) = m.stamp w s := by
  simp [submit,room,input,count,bytes]

theorem fits_stage (m : Model) (ctx s b)
    (input : b.size ≤ maxInput) (bytes : stageSize s + b.size ≤ maxStaged) :
    submit m ctx s (.feed b) = some (m.feed b s) := by
  simp [submit,input,bytes]

/-- At a completely full record even a clear which succeeds on the inner
    mathematical machine has no space to commit its audit entry. -/
theorem recovery_at_capacity {m : Model} {ctx s w t} (full : maxEntries ≤ entries s)
    (accepted : m.step ctx w s = some t) :
    m.step ctx w s = some t ∧ submit m ctx s (.frame w) = none :=
  ⟨accepted,(record_limit m ctx s w (.inl full)).1.1⟩

#print axioms total_submission
#print axioms stage_limit
#print axioms record_limit
#print axioms fits_record
#print axioms fits_stage
#print axioms recovery_at_capacity
end Aukora.Bounds12
