/-! Root v2 spike (Claude coder, 23 November 2026). Core Lean only, no release imports.
A reduced machine with the registers of the root v2 card: `id`, `refused` (one-way), `enabled`.
Signatures are an abstract `valid`; no theorem here needs an assumption about it. -/

namespace RootV2Spike

inductive FormId | legacyApproval | boundApproval | oldKeyChange | newKeyChange | clear
  deriving DecidableEq, Repr

def keyChangeForms : List FormId := [.oldKeyChange, .newKeyChange]

structure State where
  id : Option Nat
  refused : List FormId
  enabled : List FormId
  keys : Nat
  head : Nat
  halted : Bool
  pool : List Nat

inductive Frame
  | legacyApproval (intent sig : Nat)
  | boundApproval (intent sig : Nat)
  | oldKeyChange (newKeys sig : Nat)
  | newKeyChange (newKeys sig newSig : Nat)
  | clear (sig : Nat)
  | halt (sig : Nat)
  | speech (line : Nat)
  | refuse (form : FormId) (code sig : Nat)

def Frame.form : Frame → Option FormId
  | .legacyApproval .. => some .legacyApproval | .boundApproval .. => some .boundApproval
  | .oldKeyChange .. => some .oldKeyChange | .newKeyChange .. => some .newKeyChange
  | .clear .. => some .clear | _ => none

/-- Frames of the old grammar (no bound approval, no possession key change, no refusal). -/
def Frame.old : Frame → Bool
  | .boundApproval .. | .newKeyChange .. | .refuse .. => false | _ => true

def advance (s : State) : State := {s with head := s.head + 1}

section
variable (valid : Nat → List Nat → Nat → Bool)

/-- What each form does, given that the gate let it through. -/
def core (s : State) : Frame → Option State
  | .legacyApproval i σ => if !s.halted && valid s.keys [0, s.keys, i] σ then some {advance s with pool := i :: s.pool} else none
  | .boundApproval i σ => match s.id with
    | some I => if !s.halted && valid s.keys [1, I, s.head, i] σ then some {advance s with pool := i :: s.pool} else none
    | none => none
  | .oldKeyChange k σ => if valid s.keys [2, s.keys, k] σ then some {advance s with keys := k, pool := []} else none
  | .newKeyChange k σ τ =>
    if valid s.keys [3, s.keys, k] σ && valid k [3, s.keys, k] τ then some {advance s with keys := k, pool := []} else none
  | .clear σ => if valid s.keys [4, s.keys, s.head] σ then some {advance s with halted := false} else none
  | .halt σ => if valid s.keys [5, s.keys, s.head] σ then some {advance s with halted := true} else none
  | .speech _ => some (advance s)
  | .refuse k c σ => if valid s.keys [6, s.keys, s.head, c] σ then some {advance s with refused := k :: s.refused} else none

/-- The OLD machine: the reference verdict, no registers. -/
def reference (s : State) (f : Frame) : Option State := core valid s f

/-- A refusal may never take the clear or the last usable key-change form. -/
def mayRefuse (s : State) (k : FormId) : Bool :=
  k != .clear && (keyChangeForms.filter (fun j => j != k && s.enabled.contains j && !s.refused.contains j)).length > 0

def open_ (s : State) (k : FormId) : Bool := s.enabled.contains k && !s.refused.contains k

/-- Root v2: the reference verdict unless the form is refused or not enabled; refusals are guarded. -/
def step (s : State) (f : Frame) : Option State :=
  match f with
  | .refuse k _ _ => if mayRefuse s k then core valid s f else none
  | _ => match f.form with
    | some k => if open_ s k then core valid s f else none
    | none => core valid s f

/-- Variant for the attack: a refusal is guarded only against the clear. -/
def stepWeak (s : State) (f : Frame) : Option State :=
  match f with
  | .refuse k _ _ => if k != .clear then core valid s f else none
  | _ => match f.form with
    | some k => if open_ s k then core valid s f else none
    | none => core valid s f

def run (st : State → Frame → Option State) (s : State) : List Frame → State
  | [] => s
  | f :: fs => run st ((st s f).getD s) fs
end

def ordinary (keys : Nat) : State :=
  ⟨none, [], [.legacyApproval, .oldKeyChange, .clear], keys, 0, false, []⟩
def bound (I keys : Nat) : State :=
  ⟨some I, [.legacyApproval], [.legacyApproval, .boundApproval, .oldKeyChange, .newKeyChange, .clear], keys, I, false, []⟩

variable {valid : Nat → List Nat → Nat → Bool}

/-! 1. reference verdict unless refused -/
theorem ref_unless_refused {s f k} (old : f.old = true) (hk : f.form = some k) (en : s.enabled.contains k = true) :
    step valid s f = if s.refused.contains k then none else reference valid s f := by
  cases f <;> simp_all [Frame.old, Frame.form, step, open_, reference] <;> split <;> simp_all

/-! 3. refusals only grow; key changes keep the registers -/
theorem core_registers {s f t} (ok : core valid s f = some t) :
    t.id = s.id ∧ t.enabled = s.enabled ∧ (t.refused = s.refused ∨ ∃ k c σ, f = .refuse k c σ ∧ t.refused = k :: s.refused) := by
  cases f <;> simp only [core] at ok <;> (try split at ok) <;> (try split at ok) <;>
    (try (cases ok; simp [advance]; done)) <;> simp_all

theorem refused_mono {s f t} (ok : step valid s f = some t) : ∃ pre, t.refused = pre ++ s.refused := by
  have c : core valid s f = some t := by
    unfold step at ok; split at ok
    · split at ok <;> simp_all
    · split at ok
      · split at ok <;> simp_all
      · exact ok
  rcases (core_registers c).2.2 with same | ⟨k, _, _, _, eq⟩
  · exact ⟨[], by simp [same]⟩
  · exact ⟨[k], by simp [eq]⟩

theorem keychange_keeps {s f t k} (ok : core valid s f = some t) (kc : f.form = some k) (mem : k ∈ keyChangeForms) :
    t.id = s.id ∧ t.refused = s.refused ∧ t.enabled = s.enabled := by
  have r := core_registers ok
  rcases r.2.2 with same | ⟨_, _, _, eq, _⟩
  · exact ⟨r.1, same, r.2.1⟩
  · subst eq; simp [Frame.form] at kc

theorem run_mono (st : State → Frame → Option State) (mono : ∀ s f t, st s f = some t → ∃ pre, t.refused = pre ++ s.refused) :
    ∀ fs s, ∃ pre, (run st s fs).refused = pre ++ s.refused
  | [], s => ⟨[], rfl⟩
  | f :: fs, s => by
    obtain ⟨p2, e2⟩ := run_mono st mono fs ((st s f).getD s)
    cases h : st s f with
    | none => exact ⟨p2, by simp [run, h] at e2 ⊢; exact e2⟩
    | some t =>
      obtain ⟨p1, e1⟩ := mono s f t h
      exact ⟨p2 ++ p1, by simp only [run, h, Option.getD_some] at e2 ⊢; rw [e2, e1, List.append_assoc]⟩

/-! 4. a bound start refuses the legacy approval at every reachable state, whatever its bytes -/
theorem bound_refuses_legacy (I keys : Nat) (fs : List Frame) (i σ : Nat) :
    step valid (run (step valid) (bound I keys) fs) (.legacyApproval i σ) = none := by
  obtain ⟨pre, e⟩ := run_mono (step valid) (fun _ _ _ ok => refused_mono ok) fs (bound I keys)
  have mem : (run (step valid) (bound I keys) fs).refused.contains .legacyApproval = true := by
    rw [e]; simp [bound]
  simp only [step, Frame.form, open_, mem, Bool.not_true, Bool.and_false]
  rfl

/-! 2. on states reachable from the ordinary start by old-grammar frames, the OLD statement holds -/
def OldInv (s : State) : Prop := s.refused = [] ∧ s.enabled = [.legacyApproval, .oldKeyChange, .clear]

theorem old_step {s f} (inv : OldInv s) (old : f.old = true) : step valid s f = reference valid s f := by
  obtain ⟨r, e⟩ := inv
  cases f <;> simp_all [Frame.old, step, Frame.form, open_, reference]

theorem old_inv_step {s f} (inv : OldInv s) (old : f.old = true) : OldInv ((step valid s f).getD s) := by
  cases h : step valid s f with
  | none => simpa using inv
  | some t =>
    simp only [Option.getD_some]
    have c : core valid s f = some t := by rw [← h, old_step inv old]; rfl
    have r := core_registers c
    rcases r.2.2 with same | ⟨_, _, _, eq, _⟩
    · exact ⟨by rw [same, inv.1], by rw [r.2.1, inv.2]⟩
    · subst eq; simp [Frame.old] at old

theorem old_follows (keys : Nat) : ∀ (fs : List Frame), (∀ f ∈ fs, f.old = true) →
    ∀ f, f.old = true → step valid (run (step valid) (ordinary keys) fs) f = reference valid (run (step valid) (ordinary keys) fs) f := by
  suffices h : ∀ fs s, OldInv s → (∀ f ∈ fs, f.old = true) → OldInv (run (step valid) s fs) by
    intro fs all f old
    exact old_step (h fs _ ⟨rfl, rfl⟩ all) old
  intro fs
  induction fs with
  | nil => intro s inv _; exact inv
  | cons g gs ih =>
    intro s inv all
    exact ih _ (old_inv_step inv (all g (by simp))) (fun f m => all f (by simp [m]))

/-! 5 and 6. no lockout, and a refusal cannot take the clear or the last key-change form -/
def Usable (s : State) : Prop := open_ s .clear = true ∧ ∃ k ∈ keyChangeForms, open_ s k = true

theorem cannot_refuse_last {s k c σ} (last : k = .clear ∨ (keyChangeForms.filter (fun j => j != k && s.enabled.contains j && !s.refused.contains j)) = []) :
    step valid s (.refuse k c σ) = none := by
  rcases last with rfl | empty <;> simp_all [step, mayRefuse]

theorem usable_step {s f} (u : Usable s) : Usable ((step valid s f).getD s) := by
  cases h : step valid s f with
  | none => simpa using u
  | some t =>
    simp only [Option.getD_some]
    have c : core valid s f = some t := by
      unfold step at h; split at h
      · split at h <;> simp_all
      · split at h
        · split at h <;> simp_all
        · exact h
    have r := core_registers c
    rcases r.2.2 with same | ⟨k, cc, σ, eq, ref⟩
    · obtain ⟨cl, j, jm, jo⟩ := u
      refine ⟨by simp_all [open_], j, jm, by simp_all [open_]⟩
    · subst eq
      have allowed : mayRefuse s k = true := by
        simp only [step] at h; split at h <;> simp_all
      simp only [mayRefuse, Bool.and_eq_true, bne_iff_ne, ne_eq, decide_eq_true_eq] at allowed
      obtain ⟨notClear, more⟩ := allowed
      obtain ⟨j, jm⟩ := List.exists_mem_of_length_pos more
      rw [List.mem_filter] at jm
      obtain ⟨jk, cond⟩ := jm
      have ht := r.2.1
      obtain ⟨cl, _⟩ := u
      refine ⟨?_, j, jk, ?_⟩
      · simp only [open_, Bool.and_eq_true, Bool.not_eq_true'] at cl ⊢
        rw [ht, ref]
        refine ⟨cl.1, ?_⟩
        simp only [List.contains_cons, cl.2, Bool.or_false]
        cases k <;> simp_all
      · simp only [Bool.and_eq_true, bne_iff_ne, ne_eq, Bool.not_eq_true'] at cond
        simp only [open_, Bool.and_eq_true, Bool.not_eq_true']
        rw [ht, ref]
        refine ⟨cond.1.2, ?_⟩
        simp only [List.contains_cons, cond.2, Bool.or_false]
        cases j <;> cases k <;> simp_all

theorem usable_run : ∀ (fs : List Frame) s, Usable s → Usable (run (step valid) s fs)
  | [], _, u => u
  | f :: fs, s, u => usable_run fs _ (usable_step u)

theorem no_lockout {s} (u : Usable s) :
    (∀ σ, valid s.keys [4, s.keys, s.head] σ = true → (step valid s (.clear σ)).isSome) ∧
    ∃ k ∈ keyChangeForms, open_ s k = true ∧
      (k = .oldKeyChange → ∀ n σ, valid s.keys [2, s.keys, n] σ = true → (step valid s (.oldKeyChange n σ)).isSome) ∧
      (k = .newKeyChange → ∀ n σ τ, valid s.keys [3, s.keys, n] σ = true → valid n [3, s.keys, n] τ = true →
        (step valid s (.newKeyChange n σ τ)).isSome) := by
  obtain ⟨cl, k, km, ko⟩ := u
  refine ⟨fun σ v => by simp [step, Frame.form, cl, core, v], k, km, ko, ?_, ?_⟩
  · rintro rfl n σ v; simp [step, Frame.form, ko, core, v]
  · rintro rfl n σ τ v w; simp [step, Frame.form, ko, core, v, w]

theorem starts_usable (I keys : Nat) : Usable (ordinary keys) ∧ Usable (bound I keys) :=
  ⟨⟨rfl, .oldKeyChange, by decide, rfl⟩, ⟨rfl, .newKeyChange, by decide, rfl⟩⟩

/-! 7. the attack -/
/-- Round-14 case: from a bound start the owner refuses the old key change; the new one still works. -/
theorem round14 (I keys c σ : Nat) (v : valid keys [6, keys, I, c] σ = true) :
    let s := run (step valid) (bound I keys) [.refuse .oldKeyChange c σ]
    s.refused.contains .oldKeyChange = true ∧ Usable s := by
  refine ⟨?_, usable_run _ _ (starts_usable I keys).2⟩
  simp [run, step, mayRefuse, keyChangeForms, bound, core, v, advance]

/-- With the weak guard, two signed refusals leave NO key-change form: no-lockout is false there. -/
theorem weak_locks_out :
    let s := run (stepWeak (fun _ _ _ => true)) (bound 7 1) [.refuse .oldKeyChange 0 0, .refuse .newKeyChange 0 0]
    ∀ n σ τ, stepWeak (fun _ _ _ => true) s (.oldKeyChange n σ) = none ∧
      stepWeak (fun _ _ _ => true) s (.newKeyChange n σ τ) = none := by
  intro s n σ τ
  constructor <;> rfl

/-- And the strong guard refuses the second refusal in the same history. -/
theorem strong_keeps_one :
    step (fun _ _ _ => true) (run (step (fun _ _ _ => true)) (bound 7 1) [.refuse .oldKeyChange 0 0]) (.refuse .newKeyChange 0 0) = none := by
  rfl

#print axioms ref_unless_refused
#print axioms old_follows
#print axioms refused_mono
#print axioms keychange_keeps
#print axioms bound_refuses_legacy
#print axioms no_lockout
#print axioms usable_run
#print axioms cannot_refuse_last
#print axioms round14
#print axioms weak_locks_out
#print axioms strong_keeps_one
end RootV2Spike
