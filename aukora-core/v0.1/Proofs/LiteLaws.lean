import Laws
import Proofs.LiteTrace

namespace Aukora.Release
open R6.KernelCell (Context)
open private Advice7.Pair Advice7.pairGet Advice7.InnerEq.mk Advice7.InnerEq.led Advice7.InnerEq.stage
  Advice7.LedgerEq.book from Proofs.Advice
open private Advice.Equiv Advice.Equiv.refl Advice.Equiv.mk Advice.BaseEq.mk Advice.one
  Advice.stampOne Advice.pairedVerdict Advice.Equiv.toBaseEq Advice.Equiv.rules Advice.Equiv.findings
  Advice.BaseEq.inner Advice.BaseEq.keys Advice.BaseEq.risk from Proofs.AdvicePolicy

namespace LiteProof

/-!
A lite acceptance is a full-core acceptance on the same state and bytes. For
histories, remove every package submission from the full replay. Both lite
runs refuse a pair of matched installs, which also preserves L6's verdicts.
The positive support clauses cover ordinary policy commands and stamps.
-/

private theorem full {ctx w s t} (ok : lite.step ctx w s = some t) : newest.step ctx w s = some t :=
  Lite.accepted_by_full ctx ok

private theorem same {ctx w} (h : w[0]? ≠ some (27 : UInt8)) : lite.step ctx w = newest.step ctx w :=
  funext fun s => Lite.ordinary ctx w s h

private theorem refused {ctx w s} (h : newest.step ctx w s = none) : lite.step ctx w s = none := by
  cases ok : lite.step ctx w s with
  | none => rfl
  | some t => have impossible := full (ctx := ctx) ok; rw [h] at impossible; contradiction

private theorem supports (kind) : Supports lite kind := by
  intro ctx w s t cmd tagged _ found
  exact ⟨t,by simpa [lite,Lite.step,tagged.1] using found⟩

private theorem replay : ReplayLaw lite := by
  refine ⟨?_, fun _ _ => rfl, fun _ => rfl⟩
  intro ctx s xs
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | feed | reset => exact ih _
    | frame w =>
      cases h : lite.step ctx w s with
      | none => simpa [kept,run,execute,h] using ih s
      | some t => simpa [kept,run,execute,h] using ih t
    | stamp w =>
      cases h : lite.stamp w s with
      | none => simpa [kept,run,execute,h] using ih s
      | some t => simpa [kept,run,execute,h] using ih t

private theorem acceptedHistory_eq (ctx s xs) :
    acceptedHistory lite ctx s xs = acceptedHistory newest ctx s (xs.filter replayInput) := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | reset | feed | stamp => simpa [acceptedHistory,acceptedEntry,replayInput,execute,lite] using ih _
    | frame w =>
      by_cases tag : w[0]? = some (27 : UInt8)
      · simpa [acceptedHistory,acceptedEntry,replayInput,execute,lite,Lite.step,tag] using ih s
      · have eq := same (ctx := ctx) tag
        simp [acceptedHistory,acceptedEntry,replayInput,execute,tag,eq,ih]

private theorem inputRecord_eq (ctx s xs) :
    inputRecord lite ctx s xs = inputRecord newest ctx s (xs.filter replayInput) := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | reset | feed | stamp => simpa [inputRecord,acceptedBytes,replayInput,execute,lite] using ih _
    | frame w =>
      by_cases tag : w[0]? = some (27 : UInt8)
      · simpa [inputRecord,acceptedBytes,replayInput,execute,lite,Lite.step,tag] using ih s
      · have eq := same (ctx := ctx) tag
        simp [inputRecord,acceptedBytes,replayInput,execute,tag,eq,ih]

private theorem findingsIn_eq (ctx s xs) :
    findingsIn lite ctx s xs = findingsIn newest ctx s (xs.filter replayInput) := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | reset | feed | stamp => simpa [findingsIn,findingAt,replayInput,execute,lite] using ih _
    | frame w =>
      by_cases tag : w[0]? = some (27 : UInt8)
      · simpa [findingsIn,findingAt,replayInput,execute,lite,Lite.step,tag] using ih s
      · have eq := same (ctx := ctx) tag
        simp [findingsIn,findingAt,replayInput,execute,tag,eq,ih]

private theorem withoutIssue_filter (ctx s i xs) :
    withoutIssue lite ctx s i xs → withoutIssue newest ctx s i (xs.filter replayInput) := by
  induction xs generalizing s with
  | nil => intro _; trivial
  | cons c cs ih =>
    intro h
    cases c with
    | reset | feed | stamp =>
      simpa [withoutIssue,replayInput,execute,lite] using ih _ h.2
    | frame w =>
      by_cases tag : w[0]? = some (27 : UInt8)
      · have tail : withoutIssue lite ctx s i cs := by simpa [execute,lite,Lite.step,tag] using h.2
        simpa [replayInput,tag] using ih _ tail
      · simp only [List.filter_cons,replayInput,tag,ne_eq,Option.isSome]
        have eq := same (ctx := ctx) tag
        simpa [withoutIssue,replayInput,tag,execute,eq] using And.intro h.1 (ih _ h.2)

private theorem withoutRenewal_filter (ctx s i xs) :
    withoutRenewal lite ctx s i xs → withoutRenewal newest ctx s i (xs.filter replayInput) := by
  induction xs generalizing s with
  | nil => intro _; trivial
  | cons c cs ih =>
    intro h
    cases c with
    | reset | feed | stamp =>
      simpa [withoutRenewal,replayInput,execute,lite] using ih _ h.2
    | frame w =>
      by_cases tag : w[0]? = some (27 : UInt8)
      · have tail : withoutRenewal lite ctx s i cs := by simpa [execute,lite,Lite.step,tag] using h.2
        simpa [replayInput,tag] using ih _ tail
      · simp only [List.filter_cons,replayInput,tag,ne_eq,Option.isSome]
        have eq := same (ctx := ctx) tag
        simpa [withoutRenewal,replayInput,tag,execute,eq] using And.intro h.1 (ih _ h.2)

private theorem record (key start) (init : lite.genesis key = some start) : RecordLaw lite start := by
  have original := newest_record init
  refine ⟨?_,?_⟩
  · intro ctx s xs; rw [lite_replay,acceptedHistory_eq]; exact original.1 _ _ _
  · intro ctx xs; rw [lite_replay]; exact original.2 _ _

private theorem once : OnceLaw lite := by
  intro ctx w s t i hit direct
  obtain ⟨held,gen,admitted,absent,noUse⟩ := newest_once ctx w s t i (full hit) direct
  refine ⟨held,gen,admitted,absent,?_⟩
  intro xs later noIssue direct'
  rw [lite_replay]
  exact refused (noUse _ _ (withoutIssue_filter ctx t i xs noIssue) direct')

private theorem restore : RestoreLaw lite := by
  intro ctx w s t p n keys ed ml tracked hit
  obtain ⟨rules,grants,generation,forbid⟩ := newest_restore ctx w s t p n keys ed ml tracked (full hit)
  refine ⟨rules,grants,generation,?_⟩
  intro xs later i old use
  rw [lite_replay]
  exact refused (forbid _ _ _ old use)

private theorem memory (key start) (init : lite.genesis key = some start) : MemoryLaw lite start := by
  have original := newest_memory init
  refine ⟨?_,?_,?_⟩
  · intro ctx s xs; rw [lite_replay]; exact original.1 _ _ _
  · intro ctx s w t f old replacement reason hit dec act
    exact original.2.1 ctx s w t f old replacement reason (full hit) dec act
  · intro ctx xs c; rw [lite_replay,acceptedHistory_eq]; exact original.2.2 _ _ _

private theorem outcome (key start) (init : lite.genesis key = some start) :
    HistoricalOutcomeLaw lite start ∧ OutcomeTraceLaw lite start := by
  constructor
  · intro ctx xs i; dsimp only; rw [lite_replay,acceptedHistory_eq]
    exact newest_historicalOutcome init _ _ _
  · intro ctx xs k; dsimp only; rw [lite_replay,findingsIn_eq]; exact newest_outcomeTrace init _ _ _

private theorem floor (key start) (init : lite.genesis key = some start) : FloorLaw lite start := by
  have original := newest_floor init
  refine ⟨?_,?_,?_⟩
  · intro ctx xs w t; dsimp only; rw [lite_replay]
    intro tag hit; exact original.1 ctx _ w t tag (full hit)
  · intro ctx w s t p n keys ed ml cmd hit; exact original.2.1 ctx w s t p n keys ed ml cmd (full hit)
  · intro ctx xs w t; dsimp only; rw [lite_replay]
    intro tag hit; exact original.2.2 ctx _ w t tag (full hit)

private theorem expiry : ExpiryLaw lite := by
  refine ⟨?_,?_,?_⟩
  · intro ctx w s t p n last i ed ml cmd hit; exact newest_expiry.1 ctx w s t p n last i ed ml cmd (full hit)
  · intro ctx w s i state spend; exact refused (newest_expiry.2.1 ctx w s i state spend)
  · intro ctx s i xs w closed continuation spend
    rw [lite_replay]
    exact refused (newest_expiry.2.2 ctx s i _ w closed (withoutRenewal_filter ctx s i xs continuation) spend)

private theorem sameTag {s t wx wy} (match_ : Advice.Matched s t wx wy) :
    (wx[0]? = some (27 : UInt8) ∧ wy[0]? = some (27 : UInt8)) ∨
    (wx[0]? ≠ some (27 : UInt8) ∧ wy[0]? ≠ some (27 : UInt8)) := by
  cases match_ with
  | install _ _ tx ty => exact .inl ⟨tx,ty⟩
  | ordinary _ _ _ _ dx dy | rebind _ _ _ _ _ _ _ _ _ dx dy | report _ _ _ _ _ _ _ dx dy
    | use _ _ _ _ dx dy | issue _ _ _ _ _ _ _ _ _ _ dx dy | cancel _ _ _ _ _ _ _ _ _ dx dy
    | assessment _ _ _ _ _ dx dy | threshold _ _ _ _ _ dx dy => exact .inr ⟨dx.1,dy.1⟩

private theorem advicePair {s t wx wy ctx} (h : Advice.Equiv s t) (pair : Advice.Matched s t wx wy) :
    Advice7.Pair Advice.Equiv (lite.step ctx wx s) (lite.step ctx wy t) := by
  rcases sameTag pair with ⟨x,y⟩ | ⟨x,y⟩
  · simp [lite,Lite.step,x,y]; exact .none
  · rw [same x,same y]; exact Advice.one h pair

private theorem trace {s t xs ys ctx} (a : Advice.Aligned lite ctx s t xs ys) (h : Advice.Equiv s t) :
    Advice.Equiv (run lite ctx s xs) (run lite ctx t ys) ∧
      Advice.verdicts lite ctx s xs = Advice.verdicts lite ctx t ys := by
  induction a with
  | nil => exact ⟨h,rfl⟩
  | frame pair _ ih =>
    have paired := advicePair (ctx := ctx) h pair
    have tail := ih (Advice7.pairGet paired h)
    refine ⟨tail.1,?_⟩
    simp only [Advice.verdicts,tail.2,List.cons.injEq,and_true]; exact Advice.pairedVerdict paired
  | feed _ ih =>
    obtain ⟨⟨inner,keys,risk⟩,rules,findings⟩ := h
    have ledgerEq := Advice7.InnerEq.led inner
    exact ih (Advice.Equiv.mk (Advice.BaseEq.mk (Advice7.InnerEq.mk ledgerEq
      (congrArg (· ++ _) (Advice7.InnerEq.stage inner))) keys risk) rules findings)
  | reset _ ih =>
    obtain ⟨⟨inner,keys,risk⟩,rules,findings⟩ := h
    have ledgerEq := Advice7.InnerEq.led inner
    exact ih (Advice.Equiv.mk (Advice.BaseEq.mk (Advice7.InnerEq.mk ledgerEq rfl) keys risk)
      rules findings)
  | @stamp s t wx wy _ _ _ ih =>
    have left := Advice.stampOne s wx
    have right := Advice.stampOne t wy
    apply ih
    change Advice.Equiv ((newest.stamp wx s).getD s) ((newest.stamp wy t).getD t)
    constructor
    · constructor
      · rw [left.1,right.1]; exact (Advice.BaseEq.inner (Advice.Equiv.toBaseEq h))
      · rw [left.1,right.1]; exact (Advice.BaseEq.keys (Advice.Equiv.toBaseEq h))
      · exact left.2.1.trans ((Advice.BaseEq.risk (Advice.Equiv.toBaseEq h)).trans right.2.1.symm)
    · exact left.2.2.1.trans ((Advice.Equiv.rules h).trans right.2.2.1.symm)
    · exact left.2.2.2.trans ((Advice.Equiv.findings h).trans right.2.2.2.symm)

theorem lawful : Lawful lite where
  replay := replay
  record := ⟨fun ctx s xs => by rw [lite_replay,inputRecord_eq]; exact newest_rawRecord ..,
    fun ctx w s t ok => newest_lawful.record.2.1 ctx w s t (full ok),record⟩
  stale := by
    intro ctx s w f proj stale
    have hn := refused (newest_stale ctx s w f proj stale).1
    exact ⟨hn,by simp [execute,hn]⟩
  once := once
  passive := fun ctx w s t hit ps => newest_passive ctx w s t (full hit) ps
  advice := by
    intro ctx s xs ys aligned
    obtain ⟨paired,verdicts⟩ := trace aligned (Advice.Equiv.refl s)
    exact ⟨Prod.ext (Advice.BaseEq.keys (Advice.Equiv.toBaseEq paired)) (congrArg Book.auth (Advice7.LedgerEq.book (Advice7.InnerEq.led (Advice.BaseEq.inner (Advice.Equiv.toBaseEq paired))))),verdicts⟩
  restore := restore
  upgrade := fun ctx w s t hit dif => newest_upgrade ctx w s t (full hit) dif
  memory := memory
  outcome := outcome
  grants := by
    refine ⟨fun ctx w s t i hit => newest_grant ctx w s t i (full hit),?_⟩
    intro key start init
    obtain ⟨hist,empty,origin⟩ := newest_lawful.grants.2 key start init
    refine ⟨hist,empty,?_⟩
    intro ctx xs i
    rw [lite_replay]; exact origin ctx _ i
  binding := ⟨fun ctx w s t hit => newest_binding.1 ctx w s t (full hit),
    fun ctx w s t p n keys ed ml cmd hit => newest_binding.2 ctx w s t p n keys ed ml cmd (full hit)⟩
  control := ⟨fun ctx w s t x extra op ed cmd act hit => newest_control.1 ctx w s t x extra op ed cmd act (full hit),
    fun ctx w s t p n d ed ml cmd hit => newest_control.2 ctx w s t p n d ed ml cmd (full hit)⟩
  monotone := by
    intro ctx w s i low high bundle tag cmd le
    rw [same cmd.1]
    exact newest_monotone ctx w s i low high bundle tag cmd le
  floor := floor
  threshold := ⟨fun ctx w s t hit => newest_threshold ctx w s t (full hit),supports _,fun _ _ init => initial_threshold init⟩
  missing := fun ctx w s t tag hit => newest_missing ctx w s t tag (full hit)
  bundle := ⟨fun ctx w s t tag hit => newest_bundle ctx w s t tag (full hit),supports _,
    fun ctx w s t hit => newest_riskState ctx w s t (full hit)⟩
  stamping := newest_lawful.stamping
  revoke := ⟨fun ctx w s t p n d ed ml cmd hit => newest_revoke ctx w s t p n d ed ml cmd (full hit),supports _,
    fun ctx w s t hit => newest_rules ctx w s t (full hit)⟩
  expiry := ⟨expiry,supports _⟩
  correction := ⟨⟨fun _ _ => rfl,
    fun ctx w s t p n i val fix cmd hit => newest_correction.2.1 ctx w s t p n i val fix cmd (full hit),
    fun ctx w s t p n i val cmd hit => newest_correction.2.2 ctx w s t p n i val cmd (full hit)⟩,supports _⟩
  retention := fun ctx s xs => by rw [lite_replay]; exact newest_retention ctx s _

#print axioms lawful
end LiteProof
end Aukora.Release
