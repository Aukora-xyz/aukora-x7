import Proofs.FinalStep

namespace Aukora.RootFinal
open Release
open Safe11 (fullModel)
open private Release.generations_step from Proofs.PublicBehavior
open private Release.initialLedger Release.replacePool from Proofs.History
open private Kira5.Valid Kira5.Valid.mk Kira5.Valid.numbered Kira5.Valid.sourced
  Kira5.ledger_valid Kira5.origin_extend Kira5.newClaims Kira5.book_claims from Proofs.Origin
open private GrantOrigin9.preserves GrantOrigin9.initial from Proofs.GrantOrigin
open private RiskWire8.submitted RiskWire8.act_ok from Proofs.DangerWire
open private Core8.dispatch Core8.act Core8.actRoute from Ledger.Assessed
open private Release.submittedFinding from Proofs.OutcomeTrace

private theorem tag_old {w : ByteArray} {v : UInt8} (tag : Tagged w v) (ne : v ≠ 255) :
    w[0]? ≠ some (255 : UInt8) := by rw [tag]; simpa using ne

private theorem spend_old {w i} (d : Core9PolicyLaws.spends w i) :
    w[0]? ≠ some (255 : UInt8) := by
  rcases d with tr | ⟨tag,_⟩
  · exact tracked_old tr
  · exact tag_old tag (by decide)

private theorem direct_old {w i} (d : Direct w i) : w[0]? ≠ some (255 : UInt8) := by
  rcases d with ⟨tr,_⟩ | ⟨tag,_⟩
  · exact tracked_old tr
  · exact tag_old tag (by decide)

theorem full_stale : StaleLaw fullModel := by
  intro ctx s w f proj stale
  have old : w[0]? ≠ some (255 : UInt8) := by
    intro ff
    rw [Safe11.frozen_projection ff] at proj
    contradiction
  have dead := (newest_stale ctx s w f proj stale).1
  change Core9.step ctx w s = none at dead
  cases h : fullModel.step ctx w s with
  | none => exact ⟨rfl,by simp [execute,h]⟩
  | some t => exact False.elim (by rw [legacy_step old h] at dead; contradiction)

theorem full_passive : PassiveLaw fullModel := by
  intro ctx w s t hit passive
  have old : w[0]? ≠ some (255 : UInt8) := by
    cases passive with
    | ordinary cmd | report cmd | assess cmd => exact tracked_old cmd
  exact newest_passive _ _ _ _ (legacy_step old hit) passive

theorem full_control : ControlLaw fullModel :=
  ⟨fun _ _ _ _ _ _ _ _ tr ev hit => newest_control.1 _ _ _ _ _ _ _ _ tr ev (legacy_tracked tr hit),
   fun _ _ _ _ _ _ _ _ _ tr hit => newest_control.2 _ _ _ _ _ _ _ _ _ tr (legacy_tracked tr hit)⟩

theorem full_grant : GrantLaw fullModel := by
  intro ctx w s t i ok absent held
  rcases legacy_or_extra ok with old | extra
  · exact newest_grant _ _ _ _ _ old absent held
  · rcases extra.authority with ⟨_,same,_⟩ | ⟨empty,_⟩
    · exact False.elim (absent (same ▸ held))
    · simp [empty] at held

theorem full_threshold : ThresholdLaw fullModel := by
  intro ctx w s t ok changed
  rcases legacy_or_extra ok with old | extra
  · exact newest_threshold _ _ _ _ old changed
  · exact False.elim (changed extra.threshold)

theorem full_missing : MissingLaw fullModel :=
  fun _ _ _ _ tag ok => newest_missing _ _ _ _ tag (legacy_step (tag_old tag (by decide)) ok)

theorem full_bundle : BundleLaw fullModel :=
  fun _ _ _ _ tag ok => newest_bundle _ _ _ _ tag (legacy_step (tag_old tag (by decide)) ok)

theorem full_revoke : RevokeLaw fullModel :=
  fun _ _ _ _ _ _ _ _ _ tr hit => newest_revoke _ _ _ _ _ _ _ _ _ tr (legacy_tracked tr hit)

theorem full_correction : CorrectionLaw fullModel :=
  ⟨fun _ _ => rfl,fun _ _ _ _ _ _ _ _ _ tr hit =>
    newest_correction.2.1 _ _ _ _ _ _ _ _ _ tr (legacy_tracked tr hit),
   fun _ _ _ _ _ _ _ _ tr hit => newest_correction.2.2 _ _ _ _ _ _ _ _ tr (legacy_tracked tr hit)⟩

private theorem genStep {ctx w s t} (hit : fullModel.step ctx w s = some t) :
    Policy9.generation s ≤ Policy9.generation t := by
  rcases legacy_or_extra hit with old | extra
  · exact Release.generations_step old
  · rcases extra.authority with ⟨_,_,_,same⟩ | ⟨_,next⟩ <;> omega

/-- Feed, reset and stamps preserve the entire authority-bearing ledger and its projections. -/
private theorem nonframe {ctx s c} (ordinary : ∀ w, c ≠ .frame w) :
    let t := execute fullModel ctx s c
    ledger t = ledger s ∧ owner t = owner s ∧ t.rules = s.rules ∧ t.outcomes = s.outcomes := by
  cases c with
  | frame w => exact False.elim (ordinary w rfl)
  | feed | reset => exact ⟨rfl,rfl,rfl,rfl⟩
  | stamp w =>
    cases hit : fullModel.stamp w s with
    | none => simp [execute,hit]
    | some t => simp [execute,hit,(newest_stamp w s t hit).2,ledger,owner]

private theorem foldInvariant (ctx) (P : Release.State → Prop)
    (aux : ∀ {s t}, ledger t = ledger s → owner t = owner s → t.rules = s.rules →
       t.outcomes = s.outcomes → P s → P t)
    (frame : ∀ {w s t}, fullModel.step ctx w s = some t → P s → P t)
    (s xs) (init : P s) : P (run fullModel ctx s xs) := by
  induction xs generalizing s with
  | nil => exact init
  | cons c cs ih =>
    apply ih
    by_cases f : ∃ w, c = .frame w
    · obtain ⟨w,rfl⟩ := f
      cases h : fullModel.step ctx w s with
      | none => simpa [execute,h] using init
      | some t => simpa [execute,h] using frame h init
    · obtain ⟨l,o,r,v⟩ := nonframe (ctx := ctx) (s := s) (fun w e => f ⟨w,e⟩)
      exact aux l o r v init

private theorem genRun (ctx s xs) : Policy9.generation s ≤ Policy9.generation (run fullModel ctx s xs) := by
  apply foldInvariant ctx (fun t => Policy9.generation s ≤ Policy9.generation t) _ _ s xs (Nat.le_refl _)
  · intro a b same _ _ _ old
    exact Nat.le_trans old (Nat.le_of_eq (congrArg (fun l : R2.Ledger => l.book.auth.generation) same.symm))
  · exact fun h hg => Nat.le_trans hg (genStep h)

theorem signed_from {start : Release.State} (init : ∀ i ∈ pool start, GrantOrigin9.Signed (owner start) i) (ctx xs) :
    ∀ i ∈ pool (run fullModel ctx start xs), GrantOrigin9.Signed (owner (run fullModel ctx start xs)) i := by
  refine foldInvariant ctx (fun s => ∀ i ∈ pool s, GrantOrigin9.Signed (owner s) i) ?_ ?_ start xs ?_
  · intro a b same keys _ _ old i held
    change i ∈ (ledger b).book.auth.grants at held
    rw [same] at held
    exact keys ▸ old i held
  · intro w a b hit old
    rcases legacy_or_extra hit with legacy | extra
    · exact GrantOrigin9.preserves legacy old
    · rcases extra.authority with ⟨keys,poolEq,_⟩ | ⟨empty,_⟩
      · simpa [keys,poolEq] using old
      · simp [empty]
  · exact init

theorem full_signed {keys start} (init : fullModel.genesis keys = some start) (ctx xs) :
    ∀ i ∈ pool (run fullModel ctx start xs), GrantOrigin9.Signed (owner (run fullModel ctx start xs)) i :=
  signed_from (GrantOrigin9.initial init) ctx xs

theorem full_once : OnceLaw fullModel := by
  intro ctx w s t i hit direct
  have old := newest_once _ _ _ _ _ (legacy_step (direct_old direct) hit) direct
  refine ⟨old.1,old.2.1,old.2.2.1,old.2.2.2.1,?_⟩
  intro xs later noNew use
  have absent := old.2.2.2.1
  have remains : ∀ a, i ∉ pool a → withoutIssue fullModel ctx a i xs → i ∉ pool (run fullModel ctx a xs) := by
    clear noNew
    intro a
    induction xs generalizing a with
    | nil => exact fun h _ => h
    | cons c cs ih =>
      intro empty no
      apply ih _ _ no.2
      by_cases f : ∃ z, c = .frame z
      · obtain ⟨z,rfl⟩ := f
        cases h : fullModel.step ctx z a with
        | none => simpa [execute,h] using empty
        | some b =>
          simp only [execute,h,Option.getD_some]
          exact fun held => no.1 b h (full_grant ctx z a b i h empty held)
      · have eq := (nonframe (ctx := ctx) (s := a) (fun z e => f ⟨z,e⟩)).1
        change i ∉ (ledger _).book.auth.grants
        rw [eq]
        exact empty
  cases h : fullModel.step ctx later (run fullModel ctx t xs) with
  | none => rfl
  | some b => exact False.elim (remains t absent noNew (newest_once _ _ _ _ _ (legacy_step (direct_old use) h) use).1)

theorem full_restore : RestoreLaw fullModel := by
  intro ctx w s t p n keys ed ml tr ok
  obtain ⟨rules,empty,gen,_⟩ := newest_restore _ _ _ _ _ _ _ _ _ tr (legacy_tracked tr ok)
  refine ⟨rules,empty,gen,?_⟩
  intro xs later i old spend
  cases used : fullModel.step ctx later (run fullModel ctx t xs) with
  | none => rfl
  | some after_ =>
    have allowed := Core9PolicyLaws.admission_requires_open spend (legacy_step (spend_old spend) used)
    have mono := genRun ctx t xs
    simp only [Policy9.grantOK,Bool.and_eq_true,decide_eq_true_eq] at allowed
    have same := allowed.1
    omega

theorem full_expiry : ExpiryLaw fullModel := by
  refine ⟨fun _ _ _ _ _ _ _ _ _ _ tr ok => newest_expiry.1 _ _ _ _ _ _ _ _ _ _ tr (legacy_tracked tr ok),?_,?_⟩
  · intro ctx w s i cond spend
    cases hit : fullModel.step ctx w s with
    | none => rfl
    | some t =>
      have dead := Core9PolicyLaws.revoked_or_expired_refused (ctx := ctx) cond spend
      rw [legacy_step (spend_old spend) hit] at dead
      contradiction
  · intro ctx s i xs w closed noRenew spend
    have stays : ∀ a, Policy9.Closed a i → withoutRenewal fullModel ctx a i xs → Policy9.Closed (run fullModel ctx a xs) i := by
      clear noRenew
      intro a
      induction xs generalizing a with
      | nil => exact fun h _ => h
      | cons c cs ih =>
        intro h no
        apply ih _ _ no.2
        by_cases f : ∃ z, c = .frame z
        · obtain ⟨z,rfl⟩ := f
          cases ok : fullModel.step ctx z a with
          | none => simpa [execute,ok] using h
          | some b =>
            simp only [execute,ok,Option.getD_some]
            rcases legacy_or_extra ok with old | ex
            · exact Core9PolicyLaws.closed_next h old (no.1 b ok)
            · rcases ex.authority with ⟨_,_,rules,gen⟩ | ⟨_,gen⟩
              · apply Policy9.closed_persists h (Nat.le_of_eq gen.symm) _ (by rw [rules])
                unfold Policy9.nextSeq
                have bound := ex.clock
                change (ledger a).book.seq+1 ≤ (ledger b).book.seq+1
                omega
              · apply Or.inl
                rcases h with stale | ⟨same,_⟩ <;> omega
        · obtain ⟨led,_,rules,_⟩ := nonframe (ctx := ctx) (s := a) (fun z e => f ⟨z,e⟩)
          apply Policy9.closed_persists h
          · exact Nat.le_of_eq (congrArg (fun l : R2.Ledger => l.book.auth.generation) led.symm)
          · exact Nat.le_of_eq (congrArg (fun l : R2.Ledger => l.book.seq+1) led.symm)
          · rw [rules]
    have shut := Policy9.closed_refuses (stays s closed noRenew)
    cases ok : fullModel.step ctx w (run fullModel ctx s xs) with
    | none => rfl
    | some b =>
      rw [Core9PolicyLaws.admission_requires_open spend (legacy_step (spend_old spend) ok)] at shut
      contradiction

theorem floor_from {start : Release.State} (init : ∀ i ∈ pool start, GrantOrigin9.Signed (owner start) i) :
    FloorLaw fullModel start := by
  refine ⟨?_,fun _ _ _ _ _ _ _ _ _ tr hit => (newest_binding.2 _ _ _ _ _ _ _ _ _ tr (legacy_tracked tr hit)).2,?_⟩
  · intro ctx xs w t
    dsimp only
    intro tag hit
    have core := legacy_step (tag_old tag (by decide)) hit
    obtain ⟨u,dec,_,installed,_⟩ := Core9.package_admission tag core
    obtain ⟨_,_,staged,_,body,held,spent⟩ := Upgrade9.admission installed
    exact ⟨u,dec,staged ▸ body,signed_from init ctx xs u.intent held,held,spent⟩
  · intro ctx xs w t
    dsimp only
    let s := run fullModel ctx start xs
    intro tag hit
    have core := legacy_step (tag_old tag (by decide)) hit
    obtain ⟨b,dispatch,_,_,_⟩ := RiskWire8.submitted (Release.act_link tag core)
    have act : Core8.act w s.base = some b := by simpa [Core8.dispatch,tag] using dispatch
    obtain ⟨x,i,g,dec,route,_,riskOK⟩ := RiskWire8.act_ok act
    refine ⟨x,i,g,dec,route,?_⟩
    intro high
    have exactGrant : g = true := by
      cases g
      · simp [Risk8.act,Risk8.admit,Risk8.allowAt,Nat.not_lt.mpr high,s] at riskOK
      · rfl
    subst g
    have ev : x.project.action = .base (.act i) := by
      unfold Core8.actRoute at route
      split at route <;> simp_all [Wire5.Frame.project,Wire5.Action.project]
    have old : w[0]? ≠ some (27 : UInt8) := by rw [tag]; decide
    have decCmd : Policy9.decode w = some (.use i) := by
      unfold Core8.actRoute at route
      split at route <;> simp_all [Policy9.decode]
    obtain ⟨held,_,_,spent,_⟩ := newest_once ctx w s t i core (Or.inl ⟨⟨old,decCmd⟩,x,dec,ev⟩)
    exact ⟨rfl,held,spent,signed_from init ctx xs i held⟩

theorem full_floor {key start} (init : fullModel.genesis key = some start) : FloorLaw fullModel start :=
  floor_from (GrantOrigin9.initial init)

theorem full_retention : RetentionLaw fullModel := by
  intro ctx s xs
  apply foldInvariant ctx (fun t => ∃ pre, t.outcomes = pre ++ s.outcomes) _ _ s xs ⟨[],rfl⟩
  · intro a b _ _ _ same pre
    rwa [same]
  · intro w a b hit pre
    obtain ⟨rest,e⟩ := pre
    have more : ∃ next, b.outcomes = next ++ a.outcomes := by
      rcases legacy_or_extra hit with old | ex
      · exact ⟨_,Release.submittedFinding old⟩
      · exact ex.outcomes
    obtain ⟨next,h⟩ := more
    exact ⟨next ++ rest,by rw [h,e,List.append_assoc]⟩

#print axioms full_signed
#print axioms full_floor
#print axioms full_once
#print axioms full_restore
#print axioms full_expiry
#print axioms full_retention
end Aukora.RootFinal
