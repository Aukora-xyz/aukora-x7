import Proofs.RecordBinding

/-! Root v2 skeleton, step 2 (a review finding on the first skeleton step): the owner policy
registers are CARRIED by every input of the full machine, by theorem and not by inspection.
A future state constructor that forgets the field fails these proofs. -/

namespace Aukora.PolicyCarried
open Release
open Safe11 (fullModel)
open R6.KernelCell (Context)
open private Evidence11.metadata from Evidence11

/-- A frame step that never changes the owner policy registers. -/
def Keeps (next : ByteArray → Policy9.Machine → Option Policy9.Machine) : Prop :=
  ∀ w s t, next w s = some t → t.policy = s.policy

theorem submit_keeps {s : Policy9.Machine} {w c t} (h : Policy9.submit s w c = some t) :
    t.policy = s.policy := by
  simp only [Policy9.submit, Option.bind_eq_bind, Option.bind_eq_some, Option.some.injEq] at h
  obtain ⟨_, _, h⟩ := h
  cases h
  rfl

theorem policy9_keeps : Keeps Policy9.step := by
  intro w s t h
  simp only [Policy9.step, Option.bind_eq_bind, Option.bind_eq_some] at h
  obtain ⟨c, _, hit⟩ := h
  exact submit_keeps hit

theorem core9_keeps (ctx : Context) : Keeps (Core9.step ctx) := by
  intro w s t h
  unfold Core9.step at h
  split at h
  · exact policy9_keeps w s t h
  · simp only [Option.bind_eq_bind, Option.bind_eq_some, Option.some.injEq] at h
    obtain ⟨_, _, _, _, _, _, h⟩ := h
    cases h
    rfl

theorem ratchet_keeps (ctx : Context) : Keeps (Ratchet11.step ctx) := by
  intro w s t h
  unfold Ratchet11.step at h
  split at h
  · exact core9_keeps ctx w s t h
  · cases h

theorem metadata_keeps {s : Policy9.Machine} {w e r t} (h : Evidence11.metadata s w e r = some t) :
    t.policy = s.policy := by
  simp only [Evidence11.metadata, Option.bind_eq_bind, Option.bind_eq_some, Option.some.injEq] at h
  obtain ⟨_, _, h⟩ := h
  cases h
  rfl

theorem evidence_submit_keeps {s : Policy9.Machine} {w e t} (h : Evidence11.submit s w e = some t) :
    t.policy = s.policy := by
  unfold Evidence11.submit at h
  split at h
  · exact metadata_keeps h
  · exact submit_keeps h
  · split at h
    · exact metadata_keeps h
    · cases h
  · exact metadata_keeps h
  · exact metadata_keeps h
  · exact metadata_keeps h
  · split at h
    · exact metadata_keeps h
    · cases h

theorem evidence_keeps {prior} (keep : Keeps prior) : Keeps (Evidence11.step prior) := by
  intro w s t h
  simp only [Evidence11.step, Option.map_eq_some'] at h
  obtain ⟨u, routed, rfl⟩ := h
  change u.policy = s.policy
  unfold Evidence11.routed at routed
  split at routed
  · simp only [Option.bind_eq_bind, Option.bind_eq_some] at routed
    obtain ⟨c, _, rest⟩ := routed
    split at rest
    · simp only [Option.bind_eq_bind, Option.bind_eq_some] at rest
      obtain ⟨_, _, hit⟩ := rest
      exact keep w s u hit
    · cases rest
  · split at routed
    · simp only [Option.bind_eq_bind, Option.bind_eq_some] at routed
      obtain ⟨e, _, hit⟩ := routed
      exact evidence_submit_keeps hit
    · exact keep w s u routed

theorem safe_keeps {next} (keep : Keeps next) : Keeps (Safe11.step next) := by
  intro w s t h
  simp only [Safe11.step, Option.map_eq_some'] at h
  obtain ⟨u, raw, rfl⟩ := h
  change u.policy = s.policy
  unfold Safe11.raw at raw
  split at raw
  · split at raw
    · cases raw; rfl
    · cases raw
  · split at raw
    · cases raw; rfl
    · cases raw
  · split at raw
    · cases raw; rfl
    · cases raw
  · split at raw
    · cases raw; rfl
    · cases raw
  · split at raw
    · cases raw
    · exact keep w s u raw

theorem step_keeps (ctx : Context) : Keeps (fullModel.step ctx) :=
  safe_keeps (evidence_keeps (ratchet_keeps ctx))

/-- O1. Every input of the full machine carries the policy registers: frame, feed, reset, stamp. -/
theorem policy_carried (ctx : Context) (s : Release.State) (c : Input) :
    (execute fullModel ctx s c).policy = s.policy := by
  cases c with
  | frame w =>
    simp only [execute]
    cases h : fullModel.step ctx w s with
    | none => rfl
    | some t => exact step_keeps ctx w s t h
  | feed b => rfl
  | reset => rfl
  | stamp w =>
    simp only [execute]
    cases h : fullModel.stamp w s with
    | none => rfl
    | some t =>
      change (Core8.stamp w s.base).map (fun base => {s with base}) = some t at h
      obtain ⟨_, _, rfl⟩ := Option.map_eq_some'.mp h
      rfl

/-- The same for a run. -/
theorem policy_carried_run (ctx : Context) (s : Release.State) (xs : List Input) :
    (run fullModel ctx s xs).policy = s.policy := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih => simp only [run]; rw [ih, policy_carried]

/-- A seal and continuation carries the registers too (continuation rebuilds the state with `with`). -/
theorem continue_carried {sealedHead law packed s t} (ok : SegmentFinal.continueAt sealedHead law packed s = some t) :
    t.policy = s.policy := by
  unfold SegmentFinal.continueAt at ok
  split at ok
  · generalize (SegmentFinal.digest packed).data.toList = hashBytes at ok
    cases Option.some.inj ok
    rfl
  · contradiction

/-- The same along a history of inputs, seals and continuations (the history of record binding). -/
theorem policy_carried_walk (ctx : Context) :
    ∀ (ops : List RecordBinding.Op) (x : Release.State × List ByteArray),
      (RecordBinding.walk fullModel ctx x ops).1.policy = x.1.policy := by
  intro ops
  induction ops with
  | nil => intro x; rfl
  | cons o os ih =>
    intro x
    simp only [RecordBinding.walk]
    rw [ih]
    cases o with
    | input c =>
      cases c with
      | frame w =>
        simp only [RecordBinding.apply]
        cases h : fullModel.step ctx w x.1 with
        | none => rfl
        | some t => exact step_keeps ctx w x.1 t h
      | feed b => exact policy_carried ctx x.1 (.feed b)
      | reset => exact policy_carried ctx x.1 .reset
      | stamp w => exact policy_carried ctx x.1 (.stamp w)
    | «continue» prior law wire packed =>
      simp only [RecordBinding.apply]
      cases sealed : SegmentFinal.closeRecord prior law wire x.1 with
      | none => rfl
      | some pin =>
        dsimp only
        cases cont : SegmentFinal.continueAt pin law packed x.1 with
        | none => rfl
        | some u => exact continue_carried cont

/-- Every state reachable from the ordinary start has the blank policy. -/
theorem ordinary_blank {key start} (g : fullModel.genesis key = some start) (ctx : Context) (xs : List Input) :
    (run fullModel ctx start xs).policy = {} := by
  rw [policy_carried_run]
  change (Core8.genesis key).map (fun base => ({ base } : Policy9.Machine)) = some start at g
  obtain ⟨_, _, rfl⟩ := Option.map_eq_some'.mp g
  rfl

/-- Every state reachable from a bound start has the blank policy. -/
theorem bound_blank {law keys host start} (g : Bound12c.genesis law keys host = some start)
    (ctx : Context) (xs : List Input) : (run fullModel ctx start xs).policy = {} := by
  rw [policy_carried_run]
  obtain ⟨b, hit, rfl⟩ := Bound12c.genesis_old g
  change (Core8.genesis keys).map (fun base => ({ base } : Policy9.Machine)) = some b at hit
  obtain ⟨_, _, rfl⟩ := Option.map_eq_some'.mp hit
  rfl

/-- The same for histories with seals and continuations, from either start. -/
theorem ordinary_blank_walk {key start} (g : fullModel.genesis key = some start) (ctx : Context)
    (l : List ByteArray) (ops : List RecordBinding.Op) :
    (RecordBinding.walk fullModel ctx (start, l) ops).1.policy = {} := by
  rw [policy_carried_walk]
  change (Core8.genesis key).map (fun base => ({ base } : Policy9.Machine)) = some start at g
  obtain ⟨_, _, rfl⟩ := Option.map_eq_some'.mp g
  rfl

theorem bound_blank_walk {law keys host start} (g : Bound12c.genesis law keys host = some start)
    (ctx : Context) (l : List ByteArray) (ops : List RecordBinding.Op) :
    (RecordBinding.walk fullModel ctx (start, l) ops).1.policy = {} := by
  rw [policy_carried_walk]
  obtain ⟨b, hit, rfl⟩ := Bound12c.genesis_old g
  change (Core8.genesis keys).map (fun base => ({ base } : Policy9.Machine)) = some b at hit
  obtain ⟨_, _, rfl⟩ := Option.map_eq_some'.mp hit
  rfl

#print axioms policy_carried
#print axioms policy_carried_run
#print axioms policy_carried_walk
#print axioms ordinary_blank
#print axioms bound_blank
#print axioms ordinary_blank_walk
#print axioms bound_blank_walk
end Aukora.PolicyCarried
