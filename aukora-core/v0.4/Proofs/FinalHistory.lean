import Proofs.FinalCore
import Versions

namespace Aukora.RootFinal
open Release
open Safe11 (fullModel)
open R6.KernelCell (Context)
open private Root12.History12.fullStep Root12.History12.Explained Root12.History12.Sound from Proofs.Root12Record
open private Release.initialLedger Release.replacePool from Proofs.History
open private Kira5.Valid Kira5.Valid.mk Kira5.Valid.numbered Kira5.Valid.sourced
  Kira5.ledger_valid Kira5.origin_extend Kira5.newClaims Kira5.book_claims from Proofs.Origin
open private foldInvariant genRun spend_old from Proofs.FinalCore
open private Versions.legacyParsed Versions.controlParsed Versions.evidenceParsed from Versions

/-- The decoded frame that L2 appends is precisely the addressed frame. -/
private theorem recorded {ctx w s t d} (hit : fullModel.step ctx w s = some t)
    (dec : Root12.Grammar.decode fullModel.grammar s w = some d) :
    (ledger t).history = (ledger s).history ++ [d.frame] := by
  obtain ⟨d',parsed,ok,_⟩ := Root12.History12.fullStep hit
  cases Option.some.inj (dec.symm.trans parsed)
  exact ok

def Stale (m : Model) : Prop :=
  ∀ ctx s w d, Root12.Grammar.decode m.grammar s w = some d →
    (d.frame.parent ≠ (ledger s).head ∨ d.frame.seq ≠ (ledger s).book.seq+1) →
    m.step ctx w s = none ∧ execute m ctx s (.frame w) = s

theorem full_stale_installed : Stale fullModel := by
  intro ctx s w d dec address
  cases hit : fullModel.step ctx w s with
  | none => exact ⟨rfl,by simp [execute,hit]⟩
  | some t =>
    have hist := recorded hit dec
    have data : ∃ f, (ledger t).history = (ledger s).history ++ [f] ∧
        f.parent = (ledger s).head ∧ f.seq = (ledger s).book.seq+1 := by
      rcases legacy_or_extra hit with legacy | ex
      · obtain ⟨f,g,_,step⟩ := step_projection legacy
        obtain ⟨allowed,after⟩ := R2.next_spec step
        exact ⟨f,by rw [after]; rfl,allowed.1,allowed.2.1⟩
      · exact ex.history
    obtain ⟨f,history,head,next⟩ := data
    have eq : d.frame = f := by simpa using (hist.symm.trans history)
    exact False.elim (address.elim (fun bad => bad (eq ▸ head)) (fun bad => bad (eq ▸ next)))

theorem stale_bridge {m : Model} (h : Stale m) : StaleLaw m := by
  intro ctx s w f proj stale
  have legacy : Versions.Legacy w := by
    intro ff
    rw [Safe11.frozen_projection ff] at proj
    contradiction
  have parse : Root12.Grammar.decode m.grammar s w = some ⟨f,.legacy⟩ := by
    rw [Root12.Grammar.legacy_stable _ _ _ legacy,proj]
    rfl
  exact h ctx s w _ parse stale

/-- An installed cancellation has an advice-shaped ledger annotation but
    a signed revocation effect. The typed effect distinguishes that control
    from a passive observation. -/
def passivePayload : Root12.Grammar.Payload → Prop
  | .later _ _ (.cancel ..) | .later _ _ (.issue ..) | .later _ _ (.rebind ..) => False
  | _ => True

/-- On the installed grammar, every passive extension has the same authority and rule obligations. -/
def PassiveFrames (m : Model) : Prop := PassiveLaw m ∧
  ∀ ctx w s t d e, w[0]? = some (255 : UInt8) → m.step ctx w s = some t →
    Root12.Grammar.decode m.grammar s w = some d → d.frame.action = .base e →
    Aukora.Passive e → passivePayload d.payload → auth t = auth s ∧ t.rules = s.rules

theorem full_passive_installed : PassiveFrames fullModel := by
  refine ⟨full_passive,?_⟩
  intro ctx w s t d e ff hit dec act passive _
  rcases legacy_or_extra hit with old | extra
  · obtain ⟨_,_,proj,_⟩ := step_projection old
    rw [Safe11.frozen_projection ff] at proj
    contradiction
  · rcases extra.passive with quiet | ⟨f,name,h,reb⟩
    · exact quiet
    · have eq : d.frame = f := by simpa using ((recorded hit dec).symm.trans h)
      rw [← eq,act] at reb
      cases reb
      contradiction

def Memory (m : Model) (start : Release.State) : Prop :=
  (∀ ctx s xs, ∃ suffix, (ledger (run m ctx s xs)).book.claims = (ledger s).book.claims ++ suffix) ∧
  (∀ ctx s w t d old replacement reason, m.step ctx w s = some t →
      Root12.Grammar.decode m.grammar s w = some d →
      d.frame.action = .base (.correct old replacement reason) → (ledger t).book.claims = (ledger s).book.claims) ∧
  ∀ ctx xs c, c ∈ (ledger (run m ctx start xs)).book.claims → Kira5.Origin (Root12.Grammar.history m ctx start xs) c

theorem memory_from {start : Release.State}
    (initial : (ledger start).history = [] ∧ (ledger start).book.seq = 0 ∧ (ledger start).book.claims = [])
    (histories : ∀ ctx xs, (ledger (run fullModel ctx start xs)).history = Root12.Grammar.history fullModel ctx start xs) :
    Memory fullModel start := by
  refine ⟨?_,?_,?_⟩
  · intro ctx s xs
    apply foldInvariant ctx (fun t => ∃ extra, (ledger t).book.claims = (ledger s).book.claims ++ extra)
      _ _ s xs ⟨[],(List.append_nil _).symm⟩
    · intro a b same _ _ _ before
      rwa [same]
    · intro w a b hit before
      rcases legacy_or_extra hit with old | ex
      · obtain ⟨suffix,h⟩ := before
        obtain ⟨f,g,_,next⟩ := step_projection old
        have after := (R2.next_spec next).2
        refine ⟨suffix ++ Kira5.newClaims f.action,?_⟩
        rw [after]
        change (R2.nextBook (Release.replacePool (ledger a) g).book f.action).claims = _
        rw [Kira5.book_claims]
        change (ledger a).book.claims ++ _ = _
        rw [h,List.append_assoc]
      · rwa [ex.claims]
  · intro ctx s w t d old rep why hit parse action
    rcases legacy_or_extra hit with base | ex
    · obtain ⟨f,g,proj,next⟩ := step_projection base
      have eq : d.frame = f := by
        have hist : (ledger t).history = (ledger s).history ++ [f] := by rw [(R2.next_spec next).2]; rfl
        simpa using ((recorded hit parse).symm.trans hist)
      rw [(R2.next_spec next).2]
      change (R2.nextBook (Release.replacePool (ledger s) g).book f.action).claims = _
      rw [← eq,action]
      rfl
    · exact ex.claims
  · intro ctx xs c held
    have valid : Kira5.Valid (ledger (run fullModel ctx start xs)) := by
      refine foldInvariant ctx (fun t => Kira5.Valid (ledger t)) ?_ ?_ start xs ?_
      · intro a b l _ _ _ v
        rwa [l]
      · intro w a b hit v
        rcases legacy_or_extra hit with base | ex
        · obtain ⟨f,g,_,next⟩ := step_projection base
          exact Kira5.ledger_valid next (Kira5.Valid.mk (Kira5.Valid.numbered (s := ledger a) v) (Kira5.Valid.sourced (s := ledger a) v))
        · obtain ⟨f,hist,_,seq⟩ := ex.history
          apply Kira5.Valid.mk
          · intro n pos bound
            rw [hist]
            by_cases old : n ≤ (ledger a).book.seq
            · obtain ⟨x,hx,nx⟩ := Kira5.Valid.numbered v n pos old
              exact ⟨x,List.mem_append_left _ hx,nx⟩
            · have tick := ex.clock
              exact ⟨f,by simp,by omega⟩
          · intro claim mem
            rw [hist]
            exact Kira5.origin_extend (Kira5.Valid.sourced v claim (ex.claims ▸ mem)) _
      · apply Kira5.Valid.mk
        · intro n pos bound
          rw [initial.2.1] at bound
          omega
        · intro c h
          rw [initial.2.2] at h
          contradiction
    have result := Kira5.Valid.sourced valid c held
    rw [histories ctx xs] at result
    exact result

theorem full_memory {key start} (genesis : fullModel.genesis key = some start) : Memory fullModel start := by
  have initial := Release.initialLedger genesis
  apply memory_from ⟨initial.1,initial.2.2⟩
  intro ctx xs
  rw [Root12.full_record.ledger key start genesis ctx start xs,initial.1,List.nil_append]

/-- Accepted 01 frames retain the original correction and origin guarantees;
    the old trace projection never drops a frame on this restricted domain. -/
theorem memory_bridge {m : Model} {s : Release.State} (h : Memory m s) :
    (∀ ctx a xs, ∃ suffix, (ledger (run m ctx a xs)).book.claims = (ledger a).book.claims ++ suffix) ∧
    (∀ ctx a w t f old replacement why, m.step ctx w a = some t → projected w = some f →
       f.action = .base (.correct old replacement why) → (ledger t).book.claims = (ledger a).book.claims) ∧
    ∀ ctx xs c, Versions.Only01 xs → c ∈ (ledger (run m ctx s xs)).book.claims →
      Kira5.Origin (acceptedHistory m ctx s xs) c := by
  refine ⟨h.1,?_,?_⟩
  · intro ctx a w t f old rep why ok dec act
    have legacy : Versions.Legacy w := by
      intro ff
      rw [Safe11.frozen_projection ff] at dec
      contradiction
    apply h.2.1 ctx a w t ⟨f,.legacy⟩ old rep why ok _ act
    rw [Root12.Grammar.legacy_stable _ _ _ legacy,dec]
    rfl
  · intro ctx xs c old held
    rw [← Versions.old_history m ctx s xs old]
    exact h.2.2 ctx xs c held

/-- A new key-change dialect must invalidate old-generation spends along all continuations. -/
def KeyChange (m : Model) (s : Release.State) (w : ByteArray) (keys : Hybrid7.Keys) : Prop :=
  Versions.interpretations m.grammar s w = some (.rebind keys) ∨
    ∃ p n ed ml, Versions.interpretations m.grammar s w = some (.extension (.rebind p n keys ed ml))

theorem no_extension {ctx w s t} (hit : fullModel.step ctx w s = some t) (kind) :
    Versions.interpretations fullModel.grammar s w ≠ some (.extension kind) := by
  cases dispatch hit with
  | legacy old => simp [Versions.legacyParsed old]
  | evidence ff rt dec ok => simp [Versions.evidenceParsed ff rt dec]
  | note ff special noKey => simp [Versions.controlParsed hit special,noKey]
  | rebind ff rt shape sigs =>
    rw [Versions.controlParsed hit (by simp [rt]),if_pos rt]
    intro bad
    cases bad

def Restore (m : Model) : Prop := RestoreLaw m ∧
  ∀ ctx w s t keys, KeyChange m s w keys →
    m.step ctx w s = some t → t.rules = [] ∧ pool t = [] ∧
      Policy9.generation t = Policy9.generation s + 1 ∧
      ∀ xs later i, i.generation ≤ Policy9.generation s → Core9PolicyLaws.spends later i →
        m.step ctx later (run m ctx t xs) = none

theorem full_restore_installed : Restore fullModel := by
  refine ⟨full_restore,?_⟩
  intro ctx w s t keys meaning hit
  have kind : Versions.interpretations fullModel.grammar s w = some (.rebind keys) := by
    rcases meaning with k | ⟨_,_,_,_,k⟩
    · exact k
    · exact False.elim (no_extension hit _ k)
  have eff : t.rules = [] ∧ pool t = [] ∧ Policy9.generation t = Policy9.generation s + 1 := by
    cases dispatch hit with
    | legacy old => rw [Versions.legacyParsed old] at kind; cases kind
    | evidence ff rt dec ok => rw [Versions.evidenceParsed ff rt dec] at kind; cases kind
    | note ff special noKey =>
      rw [Versions.controlParsed hit special,if_neg noKey] at kind
      cases kind
    | rebind => exact ⟨rfl,rfl,rfl⟩
  refine ⟨eff.1,eff.2.1,eff.2.2,?_⟩
  intro xs later i old spend
  cases used : fullModel.step ctx later (run fullModel ctx t xs) with
  | none => rfl
  | some b =>
    have allowed := Core9PolicyLaws.admission_requires_open spend (legacy_step (spend_old spend) used)
    have mono := genRun ctx t xs
    simp only [Policy9.grantOK,Bool.and_eq_true,decide_eq_true_eq] at allowed
    have same := allowed.1
    have gen := eff.2.2
    omega

#print axioms full_stale_installed
#print axioms full_memory
#print axioms memory_bridge
#print axioms full_restore_installed
end Aukora.RootFinal
