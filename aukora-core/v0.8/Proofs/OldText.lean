import RootFinal

/-! Root v2 skeleton, step 4: the old promises still hold where records live. For every statement
restated in step 3, its v0.7 text (word for word, with `Root12.Old.Open` for `Root12.Open`, and the
state the new hypothesis speaks about restricted to `S`) follows from the NEW `RootFinal.Lawful` on
every state whose refused register is empty. By step 2 every state reachable from the ordinary start
and from a bound start has the blank policy, so the old text holds on every reachable state of the
full machine (`old_lawful_reachable`). Clauses that did not change are not repeated here: their text
is in the new set as it was. Nothing in this file is referenced by the root law set. -/

namespace Aukora.RootFinal.OldText
open Release
open Versions
open Forms
open R6.KernelCell (Context)
open ControlAvailability (Class legacyClass extensionValid evidenceClass)
open Safe11 (fullModel)

/-- Field `replay`: `Root12.Replay.feedWhen`, `resetWhen` and `PublicPorts.feed`, `reset` (all four go
    through `Root12.Open`). -/
def OldReplay (S : Release.State → Prop) (m : Model) : Prop :=
  (∀ s b, S s → Root12.Old.Open s (.feed b) → m.feed b s = Root12.fed b s) ∧
  (∀ s, S s → Root12.Old.Open s .reset → m.reset s = Root12.cleared s) ∧
  (∀ q s b, S s → q.closed = false → b.size ≤ Bounds12.maxInput →
    Bounds12.stageSize s + b.size ≤ Bounds12.maxStaged → Root12.Old.Open s (.feed b) →
    feedPort m q s b = some (Root12.fed b s)) ∧
  ∀ q s, S s → q.closed = false → Root12.Old.Open s .reset → resetPort m q s = some (Root12.cleared s)

/-- Fields `threshold`, `bundle`, `revoke`, `expiry`, `correction`: `ControlAvailability.Supports m c`. -/
def OldSupports (S : Release.State → Prop) (m : Model) (c : Class) : Prop :=
  (∀ ctx w s t c', S s → Tracked w c' → legacyClass c c' → Policy9.step w s = some t →
    Root12.Old.Open s (.frame w) → ∃ u, m.step ctx w s = some u) ∧
  (∀ ctx w s d v raw op, S s → Root12.Grammar.decode m.grammar s w = some d →
    d.payload = .later v raw op → slotAction d op → extensionValid s w d c op →
    Root12.Old.Open s (.frame w) → (m.step ctx w s).isSome = true) ∧
  ∀ ctx w s e, S s →
    (Evidence11.subtag w).any (fun tag => 40 ≤ tag && tag ≤ 43) || (Evidence11.cellSubtag w).isSome →
    Safe11.route w = .ordinary → Evidence11.decode w = some e →
    interpretations m.grammar s w = some (.evidence e.body) → evidenceClass c e.body →
    (Evidence11.submit s w e).isSome = true → Root12.Old.Open s (.frame w) → (m.step ctx w s).isSome = true

/-- Field `stamping`: `ControlAvailability.StampSupports`. -/
def OldStamping (S : Release.State → Prop) (m : Model) : Prop :=
  ∀ w s beacon receipt, S s → decodeSidecar m.grammar w = some ((ledger s).head,beacon,receipt) →
    Root12.Old.Open s (.stamp w) → (m.stamp w s).isSome = true

/-- Field `e5`: `Speech`. -/
def OldE5 (S : Release.State → Prop) (m : Model) : Prop :=
  (∀ ctx w s, S s → Tagged w 0 → (m.step ctx w s).isSome = speechReference s w) ∧
  ∀ ctx s w d v raw line, S s → Root12.Grammar.decode m.grammar s w = some d →
    d.payload = .later v raw .passive → d.frame.action = .base (.say line) →
    (m.grammar.later[v.toNat-3]?.bind (fun slot => (slot.canonicalEvidence w).bind Evidence11.decode)) = none →
    (m.step ctx w s).isSome = (Bound4.next (fun _ => Bound4.digest w) s.base.hybrid.inner d.frame).isSome

/-- Field `e6`: `Historical.E6`; `s'`, the state of the promised admission, is restricted. -/
def OldE6 (S : Release.State → Prop) (m : Model) : Prop := ∀ {ctx w s t i a w' s' b}, S s' →
  m.step ctx w s = some t → Historical.names m.grammar s w i a → Historical.names m.grammar s' w' i b →
  b.pos = a.pos → Evidence11.SameBasis (Historical.state m.grammar s) (Historical.state m.grammar s') a.pos →
  List.Forall₂ Evidence11.Weaker a.claims b.claims →
  b.bundle = ⟨(w'.extract 1 33).data.toList⟩ ∧ 0 < b.pos ∧
    b.pos ≤ s'.base.record.size ∧ b.pos < Policy9.nextSeq s' →
  Safe11.halted s' = false → routeReady m.grammar s' w' i → (m.step ctx w' s').isSome = true

/-- Field `w1`: `PriorVerdicts` and `VersionVerdicts`. -/
def OldW1 (S : Release.State → Prop) (m : Model) : Prop :=
  (∀ ctx w s, S s → Legacy w → w[0]? ≠ some (27 : UInt8) →
    (m.step ctx w s).isSome =
      if !(Safe11.halted s && !Safe11.allowedOrdinary w) &&
          (match Policy9.decode w with | some (.use i) => Historical.allows m.grammar s w i | _ => true)
      then (Policy9.step w s).isSome else false) ∧
  (∀ ctx s w (v : UInt8), S s → w[0]? = some 255 → w[1]? = some v → (v = 2 ∨ v = 3) →
    (m.step ctx w s).isSome = prefixVerdict m.grammar ctx s w) ∧
  ∀ ctx s w (v : UInt8), S s → w[0]? = some 255 → w[1]? = some v → 4 ≤ v.toNat →
    ((m.step ctx w s).isSome = true ↔
      ∃ d op, Root12.Grammar.decode m.grammar s w = some d ∧ d.payload = .later v w op ∧
        (Safe11.halted s = false ∨ haltAllowed m s w) ∧ futureReady m.grammar s w d op)

/-- The old text of every restated clause on the states `S`, one field per changed field of the set. -/
structure OldOn (S : Release.State → Prop) (m : Model) : Prop where
  replay : OldReplay S m
  threshold : OldSupports S m .threshold
  bundle : OldSupports S m .assessment
  stamping : OldStamping S m
  revoke : OldSupports S m .cancel
  expiry : OldSupports S m .issue
  correction : OldSupports S m .report
  e5 : OldE5 S m
  e6 : OldE6 S m
  w1 : OldW1 S m

private theorem opened {s : Release.State} {op} (blank : s.policy.refused = []) (o : Root12.Old.Open s op) :
    Root12.Open s op := ⟨o.1, o.2, not_refusedIn blank op⟩

private theorem supportsOn {S : Release.State → Prop} {m : Model} {c : Class}
    (blank : ∀ s, S s → s.policy.refused = []) (h : ControlAvailability.Supports m c) : OldSupports S m c :=
  ⟨fun ctx w s t c' hs tr k ok o => h.1 ctx w s t c' tr k ok (opened (blank s hs) o),
   fun ctx w s d v raw op hs dec fut act val o => h.2.1 ctx w s d v raw op dec fut act val (opened (blank s hs) o),
   fun ctx w s e hs rec rt dec int cls val o => h.2.2 ctx w s e rec rt dec int cls val (opened (blank s hs) o)⟩

/-- The new set gives back the old text wherever the refused register is empty. -/
theorem old_of_lawful {S : Release.State → Prop} {m : Model} (h : Lawful m)
    (blank : ∀ s, S s → s.policy.refused = []) : OldOn S m where
  replay := ⟨fun s b hs o => h.replay.1.feedWhen s b (opened (blank s hs) o),
    fun s hs o => h.replay.1.resetWhen s (opened (blank s hs) o),
    fun q s b hs c i st o => h.replay.2.feed q s b c i st (opened (blank s hs) o),
    fun q s hs c o => h.replay.2.reset q s c (opened (blank s hs) o)⟩
  threshold := supportsOn blank h.threshold.2.1
  bundle := supportsOn blank h.bundle.2.1
  stamping := fun w s b r hs dec o => h.stamping.2 w s b r dec (opened (blank s hs) o)
  revoke := supportsOn blank h.revoke.2.1
  expiry := supportsOn blank h.expiry.2
  correction := supportsOn blank h.correction.2
  e5 := ⟨fun ctx w s hs t => h.e5.1 ctx w s t (not_refused (blank s hs) w),
    fun ctx s w d v raw line hs dec p act none_ => h.e5.2 ctx s w d v raw line dec p act none_ (not_refused (blank s hs) w)⟩
  e6 := fun hs hit n n' pos basis weak bundle running ready =>
    h.e6 hit n n' pos basis weak bundle running (not_refused (blank _ hs) _) ready
  w1 := ⟨fun ctx w s hs old ni => h.w1.2.1 ctx w s old ni (not_refused (blank s hs) w),
    fun ctx s w v hs ff ver vs => h.w1.2.2.2.1 ctx s w v ff ver vs (not_refused (blank s hs) w),
    fun ctx s w v hs ff ver vs => h.w1.2.2.2.2 ctx s w v ff ver vs (not_refused (blank s hs) w)⟩

/-- Reachable: from the ordinary start or from a bound start, by any history of inputs, seals and
    continuations (`RecordBinding.walk`; a run of inputs is such a history). -/
def Reach (m : Model) (s : Release.State) : Prop :=
  ∃ start l ctx ops, ((∃ key, m.genesis key = some start) ∨ ∃ law keys host, Bound12c.genesis law keys host = some start) ∧
    s = (RecordBinding.walk m ctx (start, l) ops).1

theorem reach_blank {s} (r : Reach fullModel s) : s.policy.refused = [] := by
  obtain ⟨start, l, ctx, ops, from_, rfl⟩ := r
  rcases from_ with ⟨key, g⟩ | ⟨law, keys, host, g⟩
  · rw [PolicyCarried.ordinary_blank_walk g]
  · rw [PolicyCarried.bound_blank_walk g]

/-- Step 4, collected: the old text of every restated clause holds on every reachable state. -/
theorem old_lawful_reachable : OldOn (Reach fullModel) fullModel :=
  old_of_lawful full_lawful (fun _ r => reach_blank r)

theorem old_replay : OldReplay (Reach fullModel) fullModel := old_lawful_reachable.replay
theorem old_threshold : OldSupports (Reach fullModel) fullModel .threshold := old_lawful_reachable.threshold
theorem old_bundle : OldSupports (Reach fullModel) fullModel .assessment := old_lawful_reachable.bundle
theorem old_stamping : OldStamping (Reach fullModel) fullModel := old_lawful_reachable.stamping
theorem old_revoke : OldSupports (Reach fullModel) fullModel .cancel := old_lawful_reachable.revoke
theorem old_expiry : OldSupports (Reach fullModel) fullModel .issue := old_lawful_reachable.expiry
theorem old_correction : OldSupports (Reach fullModel) fullModel .report := old_lawful_reachable.correction
theorem old_e5 : OldE5 (Reach fullModel) fullModel := old_lawful_reachable.e5
theorem old_e6 : OldE6 (Reach fullModel) fullModel := old_lawful_reachable.e6
theorem old_w1 : OldW1 (Reach fullModel) fullModel := old_lawful_reachable.w1

/-! ### `BindingConflict.forced` does not go through for the restated clause -/

/-- The full machine, except that it refuses every frame of a refused form. -/
def refusing : Model :=
  {fullModel with step := fun ctx w s => if Refused s w then none else fullModel.step ctx w s}

theorem refusing_prior : PriorVerdicts refusing := by
  intro ctx w s old ni free
  have h := full_prior_verdicts ctx w s old ni free
  change (if Refused s w then none else fullModel.step ctx w s).isSome = _
  rw [if_neg free]
  exact h

/-- On any state where a frame's form is refused, the restated `PriorVerdicts` (the clause that
    `BindingConflict.forced` uses) does not force its admission: `refusing` satisfies it and refuses
    the frame. `BindingConflict.forced` now needs `Old.PriorVerdicts`, which the root no longer contains. -/
theorem forced_blocked {ctx : Context} {w : ByteArray} {s : Release.State} (r : Refused s w) :
    ¬ ∀ m : Model, PriorVerdicts m → ∃ u, m.step ctx w s = some u := by
  intro forcedAll
  obtain ⟨u, hit⟩ := forcedAll refusing refusing_prior
  change (if Refused s w then none else fullModel.step ctx w s) = some u at hit
  rw [if_pos r] at hit
  cases hit

/-- The plain approval (tag 13 hex) on a state whose refused register holds its form. -/
theorem approval_not_forced {ctx : Context} {w : ByteArray} {s : Release.State}
    (tag : w[0]? = some (0x13 : UInt8)) (act : w[3350]? = some (0x03 : UInt8))
    (refused : FormId.approval.code ∈ s.policy.refused) :
    ¬ ∀ m : Model, PriorVerdicts m → ∃ u, m.step ctx w s = some u :=
  forced_blocked ⟨.approval, formOf_approval tag act, refused⟩

/-- The legacy key change (tag 14 hex), likewise. -/
theorem key_change_not_forced {ctx : Context} {w : ByteArray} {s : Release.State}
    (tag : w[0]? = some (0x14 : UInt8)) (refused : FormId.legacyKeyChange.code ∈ s.policy.refused) :
    ¬ ∀ m : Model, PriorVerdicts m → ∃ u, m.step ctx w s = some u :=
  forced_blocked ⟨.legacyKeyChange, formOf_legacyKeyChange tag, refused⟩

#print axioms old_of_lawful
#print axioms reach_blank
#print axioms old_lawful_reachable
#print axioms forced_blocked
#print axioms approval_not_forced
#print axioms key_change_not_forced
end Aukora.RootFinal.OldText
