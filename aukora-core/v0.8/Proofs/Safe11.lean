import Safe11
import Laws

namespace Aukora.Safe11

open R6.KernelCell (Context)
abbrev Input := Core9PolicyLaws.Input

def execute (next : Next) (s : Machine) : Input → Machine
  | .frame w => (step next w s).getD s
  | .feed b => Core9.feed b s
  | .reset => Core9.reset s
  | .stamp w => (Core9.stamp w s).getD s

def run (next : Next) (s : Machine) (xs : List Input) : Machine := xs.foldl (execute next) s

private theorem wrote {next w s t} (ok : step next w s = some t) :
    t.base.record = s.base.record.push w := by
  obtain ⟨u, _, rfl⟩ := Option.map_eq_some'.mp ok
  rfl

private theorem flag_of_record {s t : Machine} {w : ByteArray}
    (record : t.base.record = s.base.record.push w) :
    halted t = flagAfter (halted s) w := by
  simp [halted, record, List.foldl_append]

private theorem flag_of_step {next w s t} (ok : step next w s = some t) :
    halted t = flagAfter (halted s) w := flag_of_record (wrote ok)

/-- H1. While halted every ordinary frame outside the finite legal set is refused. -/
theorem H1_blocked {next w s} (h : halted s = true) (r : route w = .ordinary)
    (barred : allowedOrdinary w = false) : step next w s = none := by
  simp [step, raw, r, h, barred]

/-- These decoded commands include both act routes, direct and timed grants, capabilities and spending. -/
def Destructive : Policy9.Command → Prop
  | .use .. | .issue .. => True
  | .ordinary x _ =>
    match x.action with
    | .grant .. | .plain (.spend ..) | .plain (.useMandate ..) | .plain (.base (.act ..))
    | .plain (.base (.upgrade ..)) | .plain (.base (.grant ..)) | .control (.mandate _) _
    | .control (.grantBudget _) _ | .control (.pass _) _ => True
    | _ => False
  | _ => False

theorem destructive_denied {c : Policy9.Command} (bad : Destructive c) : allowedCommand c = false := by
  cases c with
  | ordinary x e =>
    cases a : x.action with
    | plain op =>
      cases op with
      | base ev => cases ev <;> simp_all [Destructive, allowedCommand]
      | _ => simp_all [Destructive, allowedCommand]
    | control op sig => cases op <;> simp_all [Destructive, allowedCommand]
    | _ => simp_all [Destructive, allowedCommand]
  | _ => simp_all [Destructive, allowedCommand]

theorem H1_destructive {next w s c} (h : halted s = true) (r : route w = .ordinary)
    (dec : Policy9.decode w = some c) (bad : Destructive c) : step next w s = none := by
  apply H1_blocked h r
  simp [allowedOrdinary, dec, destructive_denied bad]

/-- All installation packages are refused while halted, independently of the staged file, grant and checker. -/
theorem H1_upgrade {next w s} (h : halted s = true) (tag : w[0]? = some (27 : UInt8)) :
    step next w s = none := by
  apply H1_blocked h
  · simp [route, tag]
  · simp [allowedOrdinary, outcomeWire, Policy9.decode, Core8.request, tag]

/-- The halted filter passes each legal ordinary frame through the same underlying admission checks. -/
theorem legal_ordinary {next w s} (r : route w = .ordinary) (yes : allowedOrdinary w = true) :
    (step next w s).isSome = (next w s).isSome := by
  simp [step, raw, r, yes]

/-- The owner clear is the single command that can take a halted state back to running. -/
def ValidClear (s : Machine) (w : ByteArray) : Prop :=
  route w = .clear ∧ shape s w 51 = true ∧ Both s w 51

private theorem needs_owner {next w s t} (r : route w = .clear) (ok : step next w s = some t) :
    ValidClear s w := by
  by_cases auth : ownerOK s w 51 = true
  · exact ⟨r, (owner_iff ..).mp auth⟩
  · simp [step, raw, r, auth] at ok

private theorem no_clear_keeps {next w s} (stopped : halted s = true) (no : ¬ValidClear s w) :
    halted ((step next w s).getD s) = true := by
  cases ok : step next w s with
  | none => exact stopped
  | some t =>
    have f := flag_of_step ok
    cases r : route w with
    | clear => exact False.elim (no (needs_owner r ok))
    | _ => simpa [flagAfter, r, stopped] using f

/-- A trace is free of owner clears when each frame lacks a valid clear for its actual pre-state. -/
def NoClear (next : Next) (s : Machine) : List Input → Prop
  | [] => True
  | c :: cs => (match c with | .frame w => ¬ValidClear s w | _ => True) ∧
    NoClear next (execute next s c) cs

private theorem other_input {next s} {c : Input} (no : ∀ w, c ≠ .frame w) :
    (execute next s c).base.record = s.base.record := by
  cases c with
  | frame w => exact False.elim (no w rfl)
  | feed | reset => rfl
  | stamp w =>
    cases h : Core8.stamp w s.base with
    | none => simp [execute, Core9.stamp, h]
    | some t => simp [execute, Core9.stamp, h, (Stamp8.accepted h).2]

/-- H2. No sequence lacking a clear signed by both current keys can leave the halted state. -/
theorem H2_no_escape (next : Next) (s : Machine) (xs : List Input) (stopped : halted s = true)
    (no : NoClear next s xs) : halted (run next s xs) = true := by
  induction xs generalizing s with
  | nil => exact stopped
  | cons c cs ih =>
    change halted (run next (execute next s c) cs) = true
    apply ih _ _ no.2
    cases c with
    | frame w => exact no_clear_keeps stopped no.1
    | _ =>
      unfold halted
      rw [other_input (by intro w h; cases h)]
      exact stopped

/-- H3. Clearing retains the grant pool and leaves every revoked, expired or stale intent closed. -/
theorem H3_clear_closed {next w s t} (r : route w = .clear) (ok : step next w s = some t) :
    Policy9.pool t.base = Policy9.pool s.base ∧
    ∀ i, Policy9.Closed s i → Policy9.Closed t i ∧ Policy9.grantOK t i = false := by
  have auth := (owner_iff ..).mpr (needs_owner r ok).2
  have result : some ({(metadata s w "clear") with base.record := s.base.record.push w} : Machine) = some t := by
    simpa [step, raw, r, auth] using ok
  cases Option.some.inj result
  refine ⟨rfl, ?_⟩
  intro i before
  have remains := Policy9.closed_persists (t := {(metadata s w "clear") with base.record := s.base.record.push w})
    before (Nat.le_refl _) (Nat.le_succ _) rfl
  exact ⟨remains, Policy9.closed_refuses remains⟩

/-- H4. Every committed wire, including each halt, is retained at the same position on every continuation. -/
theorem H4_record (next : Next) (s : Machine) (xs : List Input) :
    ∃ suffix, (run next s xs).base.record.toList = s.base.record.toList ++ suffix := by
  induction xs generalizing s with
  | nil => exact ⟨[], (List.append_nil _).symm⟩
  | cons c cs ih =>
    obtain ⟨suffix, later⟩ := ih (execute next s c)
    change ∃ _, (run next (execute next s c) cs).base.record.toList = _
    rw [later]
    cases c with
    | frame w =>
      cases ok : step next w s with
      | none => exact ⟨suffix, by simp [execute, ok]⟩
      | some t => exact ⟨w :: suffix, by simp [execute, ok, wrote ok, List.append_assoc]⟩
    | _ => exact ⟨suffix, by rw [other_input (by intro w h; cases h)]⟩

/-- H5. From every state a well-formed current-head, next-sequence clear with both signatures is admitted and clears. -/
theorem H5_clear (next : Next) {s w} (good : ValidClear s w) :
    ∃ t, step next w s = some t ∧ halted t = false := by
  have sig := (owner_iff ..).mpr good.2
  have ok : step next w s = some ({(metadata s w "clear") with base.record := s.base.record.push w} : Machine) := by
    simp [step, raw, good.1, sig]
  exact ⟨_, ok, by simpa [flagAfter, good.1] using flag_of_step ok⟩

/-- An equally addressed, doubly signed rebind to valid new keys succeeds and preserves the halt. -/
theorem H5_rebind (next : Next) {s w} (r : route w = .rebind) (format : shape s w 53 = true)
    (sigs : Both s w 53) (valid : Hybrid7.validKey (newKeys s w) = true) :
    ∃ t, step next w s = some t ∧ t.base.hybrid.owner = newKeys s w ∧
      Policy9.pool t.base = [] ∧ Policy9.generation t = Policy9.generation s + 1 ∧ halted t = halted s := by
  have sig := (owner_iff ..).mpr ⟨format, sigs⟩
  have ok : step next w s = some ({(rebound s w) with base.record := s.base.record.push w} : Machine) := by
    simp [step, raw, r, sig, valid]
  exact ⟨_, ok, rfl, rfl, rfl, by simpa [flagAfter, r] using flag_of_step ok⟩

/-- An owner halt sets the flag and commits its exact signed bytes. -/
theorem owner_halts (next : Next) {s w} (r : route w = .halt) (format : shape s w 50 = true)
    (sigs : Both s w 50) :
    ∃ t, step next w s = some t ∧ t.base.record = s.base.record.push w ∧ halted t = true := by
  have sig := (owner_iff ..).mpr ⟨format, sigs⟩
  have ok : step next w s = some ({(metadata s w "halt") with base.record := s.base.record.push w} : Machine) := by
    simp [step, raw, r, sig]
  exact ⟨_, ok, wrote ok, by simpa [flagAfter, r] using flag_of_step ok⟩

/-- The host can record a reproducible act refusal at the current head; this records its wire and halts. -/
theorem refusal_halts (next : Next) {s w} (r : route w = .refusal) (open_ : halted s = false)
    (witness : refusedAct next s w = true) :
    ∃ t, step next w s = some t ∧ t.base.record = s.base.record.push w ∧ halted t = true := by
  have ok : step next w s = some ({(metadata s w "refused-act") with base.record := s.base.record.push w} : Machine) := by
    simp [step, raw, r, open_, witness]
  exact ⟨_, ok, wrote ok, by simpa [flagAfter, r] using flag_of_step ok⟩

/-- R10's pinned L2 projection rejects every release-2 event prefix. -/
theorem frozen_projection {w : ByteArray} (tag : w[0]? = some (255 : UInt8)) :
    Release.projected w = none := by
  simp [Release.projected, Policy9.decode, Core8.request, tag]

/-- R10 L2 contradicts admission of any ff-prefixed wire by the carried model. -/
theorem incompatible_L2 {m : Release.Model} {ctx w s t}
    (tag : w[0]? = some (255 : UInt8)) (ok : m.step ctx w s = some t) : ¬Release.Lawful m := by
  intro lawful
  obtain ⟨f, found⟩ := lawful.record.2.1 ctx w s t ok
  rw [frozen_projection tag] at found
  contradiction

/-- A single well-formed, duly signed clear witnesses failure of frozen R10 L2 for this step. -/
theorem valid_clear_excludes_R10 {m : Release.Model} {ctx next s w}
    (implements : m.step ctx = step next) (good : ValidClear s w) : ¬Release.Lawful m := by
  obtain ⟨t, accepted, _⟩ := H5_clear next good
  have tag : w[0]? = some (255 : UInt8) := by
    have r := good.1
    unfold route at r
    split at r
    · rename_i version
      exact version.1
    · contradiction
  exact incompatible_L2 tag (implements ▸ accepted)

/-- R10 P2 contradicts refusal of any R10-eligible timed issue, including one issued while halted. -/
theorem incompatible_P2 {m : Release.Model} {ctx w s t p seq expiry i ed ml}
    (cmd : Release.Tracked w (.issue p seq expiry i ed ml)) (legacy : Policy9.step w s = some t)
    (refused : m.step ctx w s = none) : ¬Release.Lawful m := by
  intro lawful
  obtain ⟨u, accepted⟩ := lawful.expiry.2 ctx w s t _ cmd trivial legacy
  rw [refused] at accepted
  contradiction

#print axioms H1_blocked
#print axioms H1_destructive
#print axioms H1_upgrade
#print axioms legal_ordinary
#print axioms H2_no_escape
#print axioms H3_clear_closed
#print axioms H4_record
#print axioms H5_clear
#print axioms H5_rebind
#print axioms owner_halts
#print axioms refusal_halts
#print axioms incompatible_L2
#print axioms valid_clear_excludes_R10
#print axioms incompatible_P2
end Aukora.Safe11
