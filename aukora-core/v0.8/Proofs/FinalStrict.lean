import RootFinal

namespace Aukora.RootFinal.Strict
open Release
open Safe11 (fullModel)
open private Root12.History12.history Root12.History12.view from Proofs.Root12Record
open private Versions.allFindings from Versions

/-- A mathematical countermodel for entailment: empty history, empty pool,
    zero threshold, and the same operation functions, with constant genesis. -/
private def blank : Release.State :=
  ⟨⟨⟨Bound4.initial 0, ⟨[], []⟩⟩, Risk8.initial, #[], #[]⟩, [], [], {}⟩
private def candidate : Model := {fullModel with genesis := fun _ => some blank}

private theorem hist (ctx xs) : (ledger (run fullModel ctx blank xs)).history =
    Root12.Grammar.history fullModel ctx blank xs := Root12.History12.history ctx blank xs

private theorem initialSigned : ∀ i ∈ pool blank, GrantOrigin9.Signed (owner blank) i := by
  intro i h
  exact False.elim (List.not_mem_nil h)

private theorem found : Outcome fullModel blank := by
  constructor
  · intro ctx xs i
    dsimp only
    unfold everConfirmed
    rw [hist]
    by_cases exists_ : ∃ f ∈ Root12.Grammar.history fullModel ctx blank xs, f.action = .base (.outcome i .confirmed)
    · have h : (Root12.Grammar.history fullModel ctx blank xs).any (fun f => decide (f.action = .base (.outcome i .confirmed))) = true := by simpa using exists_
      simp [h,exists_]
    · have h : (Root12.Grammar.history fullModel ctx blank xs).any (fun f => decide (f.action = .base (.outcome i .confirmed))) = false := by simpa using exists_
      simp [h,exists_]
  · intro ctx xs key
    have eq := Versions.allFindings ctx blank xs
    change _ = _ ++ [] at eq
    rw [List.append_nil] at eq
    refine ⟨eq,?_⟩
    change Policy9.outcomeCode _ key = _
    rw [← eq]

private theorem historyEq (ctx s xs) :
    Root12.Grammar.history candidate ctx s xs = Root12.Grammar.history fullModel ctx s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    simp only [Root12.Grammar.history,ih]
    rfl

private theorem findingsEq (ctx s xs) : findings candidate ctx s xs = findings fullModel ctx s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    simp only [findings,ih]
    cases c <;> rfl

private theorem withoutEq (ctx p s xs) : without candidate ctx p s xs ↔ without fullModel ctx p s xs := by
  induction xs generalizing s with
  | nil => exact Iff.rfl
  | cons c cs ih =>
    simp only [without,ih]
    exact Iff.rfl

private theorem adviceEq {ctx s t xs ys} (h : VersionAdvice.Aligned candidate ctx s t xs ys) :
    VersionAdvice.Aligned fullModel ctx s t xs ys := by
  induction h with
  | nil => exact .nil
  | frame left right _ tail => exact .frame left right tail

private theorem candidate_record : Record candidate where
  raw := full_record.raw
  version := full_record.version
  parses := full_record.parses
  ledger := by
    intro k init g ctx s xs
    rw [historyEq]
    exact Root12.History12.history ctx s xs
  view := by
    intro _ s h ctx xs
    cases Option.some.inj h
    apply Root12.History12.view
    intro _ member
    exact False.elim (List.not_mem_nil member)
  consistent := full_record.consistent

private theorem admitted : Lawful candidate where
  replay := by
    have r : Root12.Replay candidate := ⟨Root12.full_replay.kept,Root12.full_replay.feedEffect,
      Root12.full_replay.resetEffect,Root12.full_replay.feedWhen,Root12.full_replay.resetWhen⟩
    exact ⟨r,ports_of_replay r⟩
  record := candidate_record
  stale := full_lawful.stale
  once := by
    intro ctx w s t i ok direct
    obtain ⟨a,b,c,d,tail⟩ := full_lawful.once ctx w s t i ok direct
    exact ⟨a,b,c,d,fun xs later no => tail xs later ((withoutEq ..).mp no)⟩
  passive := full_lawful.passive
  advice := ⟨full_advice,fun ctx s t xs ys equal paired => full_versionAdvice.2 ctx s t xs ys equal (adviceEq paired)⟩
  restore := full_lawful.restore
  upgrade := full_lawful.upgrade
  memory := by
    intro _ s g
    cases Option.some.inj g
    have ref := memory_from ⟨rfl,rfl,rfl⟩ hist
    exact ⟨ref.1,ref.2.1,by intro ctx xs c h; rw [historyEq]; exact ref.2.2 ctx xs c h⟩
  outcome := by
    intro _ s g
    cases Option.some.inj g
    constructor
    · intro ctx xs i
      dsimp only
      rw [historyEq]
      exact found.1 ctx xs i
    · intro ctx xs key
      dsimp only
      rw [findingsEq]
      exact found.2 ctx xs key
  grants := ⟨full_grantSource,by intro _ s g; cases Option.some.inj g; exact ⟨rfl,rfl,signed_from initialSigned⟩⟩
  binding := full_lawful.binding
  control := full_lawful.control
  monotone := full_lawful.monotone
  floor := by intro _ s g; cases Option.some.inj g; exact Ports.floor_of_legacy (floor_from initialSigned) full_binding
  threshold := ⟨full_lawful.threshold.1,full_lawful.threshold.2.1,by intro _ s g; cases Option.some.inj g; rfl⟩
  missing := full_lawful.missing
  bundle := full_lawful.bundle
  stamping := full_lawful.stamping
  revoke := full_lawful.revoke
  expiry := ⟨⟨full_expiry_installed.1,full_expiry_installed.2.1,
      fun ctx s i xs w closed no => full_expiry_installed.2.2 ctx s i xs w closed ((withoutEq ..).mp no)⟩,
      full_lawful.expiry.2⟩
  correction := full_lawful.correction
  retention := full_lawful.retention
  e1 := @full_lawful.e1
  e1b := @full_lawful.e1b
  e2 := @full_lawful.e2
  e3 := full_lawful.e3
  e4 := @full_lawful.e4
  e5 := full_lawful.e5
  e6 := @full_lawful.e6
  h1 := full_lawful.h1
  h2 := fun ctx s xs halted no => Root12.full_supplement.h2 ctx s xs halted
    ((Historical.noClear_iff candidate rfl ctx s xs).mp no)
  h3 := full_lawful.h3
  h4 := full_lawful.h4
  h5 := ⟨full_lawful.h5.1,SessionFinal.full_recovery,SegmentFinal.rollover candidate⟩
  succession := full_lawful.succession
  w1 := full_lawful.w1
  b1 := (RecordBinding.separation_congr (m := candidate) (m' := fullModel) rfl).mpr full_lawful.b1
  b2 := (RecordBinding.refusal_congr (m := candidate) (m' := fullModel) rfl).mpr full_lawful.b2
  b3 := by
    intro law keys host s ok
    obtain ⟨v, mem, out, gr, fl, th⟩ := BoundStart.full_start law keys host s ok
    refine ⟨v, ⟨mem.1, mem.2.1, by intro ctx xs c h; rw [historyEq]; exact mem.2.2 ctx xs c h⟩, ⟨?_, ?_⟩, gr, fl, th⟩
    · intro ctx xs i
      dsimp only
      rw [historyEq]
      exact out.1 ctx xs i
    · intro ctx xs key
      dsimp only
      rw [findingsEq]
      exact out.2 ctx xs key
  b4 := (Rebinding.readdressed_congr (m := candidate) (m' := fullModel) rfl).mpr full_lawful.b4
  pinned := Pin.of_clauses full_lawful.succession full_lawful.upgrade
  r_mono := full_lawful.r_mono
  id_fixed := full_lawful.id_fixed

/-- The 40th law (after the 39 of v0.6) rules out a machine that satisfies every final-root clause.
    No key or cryptographic conjecture is needed for this strict inclusion. -/
theorem genuinely_stronger :
    ∃ m : Model, Lawful m ∧ ¬Ratchet11.addLaw Lawful "standard-genesis" (fun x => x.genesis = Core9.genesis) m := by
  refine ⟨candidate,admitted,?_⟩
  intro strong
  have eq := congrFun strong.2 ByteArray.empty
  change some blank = none at eq
  cases eq

#print axioms genuinely_stronger
end Aukora.RootFinal.Strict
