import Proofs.Versions
import Proofs.FinalAdvice
import SessionFinal
namespace Aukora.RootFinal.Historical
open Release
open Safe11 (fullModel)
open Versions
open R6.KernelCell (Context)
open private Root12.Grammar.second from Laws
open private Root12.header from Proofs.Root12Grammar
open private RootFinal.noFuture from Proofs.Versions

inductive RecoveryEvent where
  | clear
  | rebind (keys : Hybrid7.Keys)
  deriving DecidableEq

def recoveryEvent : Root12.Grammar.Payload → Option RecoveryEvent
  | .clear => some .clear
  | .rebind keys => some (.rebind keys)
  | _ => none

def Recognized (g : WireGrammar) (s : Release.State) (w : ByteArray) (k : RecoveryEvent) : Prop :=
  ∃ d, Root12.Grammar.decode g s w = some d ∧ recoveryEvent d.payload = some k

private def Canonical (s : Release.State) (w : ByteArray) : RecoveryEvent → Prop
  | .clear => Safe11.route w = .clear ∧ Safe11.shape s w 51 = true
  | .rebind keys => Safe11.route w = .rebind ∧ Safe11.shape s w 53 = true ∧ keys = Safe11.newKeys s w

private theorem canonical {g s w k} (got : Recognized g s w k) : Canonical s w k := by
  obtain ⟨d,hit,kind⟩ := got
  by_cases ff : w[0]? = some (255 : UInt8)
  · cases tag : w[1]? with
    | none => simp [Root12.Grammar.decode,ff,tag] at hit
    | some v =>
      cases on_ : g.versionTwo with
      | false => simp [Root12.Grammar.decode,ff,tag,on_] at hit
      | true =>
        by_cases v2 : v = 2
        · subst v
          have part : Root12.Grammar.second s w = some d := by
            simpa [Root12.Grammar.decode,ff,tag,on_] using hit
          cases rt : Safe11.route w with
          | ordinary =>
            obtain ⟨e,_,eq⟩ := Option.bind_eq_some.mp (by simpa only [Root12.Grammar.second,rt] using part)
            cases Option.some.inj eq
            contradiction
          | halt | clear | rebind =>
            simp only [Root12.Grammar.second,rt] at part
            obtain ⟨_,guard_,eq⟩ := Option.bind_eq_some.mp part
            cases Option.some.inj eq
            simp only [recoveryEvent,Option.some.injEq,reduceCtorEq] at kind
            all_goals
              subst k
              simp_all [Canonical,guard]
          | refusal =>
            simp only [Root12.Grammar.second,rt] at part
            obtain ⟨_,_,p⟩ := Option.bind_eq_some.mp part
            obtain ⟨cmd,_,eq⟩ := Option.bind_eq_some.mp p
            cases cmd <;> cases eq <;> contradiction
        · have inner : (do
            guard (3 ≤ v.toNat)
            let slot ← g.later[v.toNat - 3]?
            let f ← slot.project s w
            if v = 3 then
              let e ← Evidence11.decode w
              return (⟨f,.versionThree e⟩ : Root12.Grammar.Decoded)
            let op ← slot.interpret s w
            return (⟨f,.later v w op⟩ : Root12.Grammar.Decoded)) = some d := by
              simpa [Root12.Grammar.decode,ff,tag,on_,v2] using hit
          obtain ⟨_,_,part⟩ := Option.bind_eq_some.mp inner
          obtain ⟨slot,_,part⟩ := Option.bind_eq_some.mp part
          obtain ⟨f,_,part⟩ := Option.bind_eq_some.mp part
          split at part
          · obtain ⟨env,_,eq⟩ := Option.bind_eq_some.mp part
            cases Option.some.inj eq
            contradiction
          · change (slot.interpret s w).bind (fun op => some (⟨f,.later v w op⟩ : Root12.Grammar.Decoded)) = some d at part
            obtain ⟨op,_,eq⟩ := Option.bind_eq_some.mp part
            cases Option.some.inj eq
            contradiction
  · rw [Root12.Grammar.legacy_stable _ _ _ ff] at hit
    obtain ⟨f,_,rfl⟩ := Option.map_eq_some'.mp hit
    contradiction

private theorem recognized {g s w k} (installed : g.versionTwo = true) (valid : Canonical s w k) :
    Recognized g s w k := by
  cases k with
  | clear =>
    obtain ⟨rt,shape⟩ := valid
    obtain ⟨ff,v2⟩ := Root12.header rt (by decide)
    refine ⟨⟨⟨Safe11.head s,Policy9.nextSeq s,.base (.advise "AUKORA/R11/clear" 0)⟩,.clear⟩,?_,rfl⟩
    simp [Root12.Grammar.decode,ff,v2,installed,Root12.Grammar.second,rt,shape,guard]
  | rebind keys =>
    obtain ⟨rt,shape,rfl⟩ := valid
    obtain ⟨ff,v2⟩ := Root12.header rt (by decide)
    let keys := Safe11.newKeys s w
    refine ⟨⟨⟨Safe11.head s,Policy9.nextSeq s,.base (.rebind (Wire5.keyName keys.ed) true)⟩,.rebind keys⟩,?_,rfl⟩
    simp [Root12.Grammar.decode,ff,v2,installed,Root12.Grammar.second,rt,shape,guard,keys]

def ValidClear (g : WireGrammar) (s : Release.State) (w : ByteArray) : Prop :=
  Recognized g s w .clear ∧ Safe11.Both s w 51

theorem clear_iff {g : WireGrammar} (on_ : g.versionTwo = true) {s w} :
    ValidClear g s w ↔ Safe11.ValidClear s w :=
  ⟨fun h => ⟨(canonical h.1).1,(canonical h.1).2,h.2⟩,
   fun h => ⟨recognized on_ ⟨h.1,h.2.1⟩,h.2.2⟩⟩

def noClear (m : Model) (ctx : Context) (s : Release.State) : List Input → Prop
  | [] => True
  | c :: cs => (match c with | .frame w => ¬ValidClear m.grammar s w | _ => True) ∧
    noClear m ctx (execute m ctx s c) cs

theorem noClear_iff (m : Model) (on_ : m.grammar.versionTwo = true) (ctx s xs) :
    noClear m ctx s xs ↔ Safe11.noClearInputs m ctx s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c <;> simp only [noClear,Safe11.noClearInputs,ih,clear_iff on_]

def Confinement (m : Model) : Prop :=
  ∀ ctx s xs, Safe11.halted s = true → noClear m ctx s xs → Safe11.halted (run m ctx s xs) = true

theorem full_confinement : Confinement fullModel := fun ctx s xs halted no =>
  Root12.full_supplement.h2 ctx s xs halted ((noClear_iff fullModel rfl ctx s xs).mp no)

def ClearEffect (m : Model) : Prop :=
  ∀ ctx s w t, Recognized m.grammar s w .clear → m.step ctx w s = some t →
    pool t = pool s ∧ ∀ i, Policy9.Closed s i → Policy9.Closed t i ∧ Policy9.grantOK t i = false

theorem full_clearEffect : ClearEffect fullModel := fun ctx s w t rec ok =>
  Root12.full_supplement.h3 ctx s w t (canonical rec).1 ok

/-- Dedicated recovery bindings carry their old dual-signature domains.
    A later slot can declare an equivalently addressed key-change operation.
    Either form may recover without an ordinary delivery grant. -/
def ValidRebind (g : WireGrammar) (s : Release.State) (w : ByteArray) (keys : Hybrid7.Keys) : Prop :=
  Hybrid7.validKey keys = true ∧ ((Recognized g s w (.rebind keys) ∧ Safe11.Both s w 53) ∨
    ∃ p n ed ml, interpretations g s w = some (.extension (.rebind p n keys ed ml)) ∧
      addressed s p n ∧ Hybrid7.Both Core8.verifiers (owner s) (futureRebindMessage s p n keys) ed ml)

def Recovery (m : Model) : Prop :=
  (∀ ctx s w, ValidClear m.grammar s w → ∃ t, m.step ctx w s = some t ∧ Safe11.halted t = false) ∧
    ∀ ctx s w keys, ValidRebind m.grammar s w keys →
      ∃ t, m.step ctx w s = some t ∧ owner t = keys ∧ pool t = [] ∧
        Policy9.generation t = Policy9.generation s + 1 ∧ Safe11.halted t = Safe11.halted s

private theorem absentExtension {s w op} : interpretations fullModel.grammar s w ≠ some (.extension op) := by
  intro some_
  obtain ⟨d,hit,eq⟩ := Option.map_eq_some'.mp some_
  cases pe : d.payload <;> simp [meaning,pe] at eq
  next v raw k => exact RootFinal.noFuture hit pe

theorem full_recovery : Recovery fullModel := by
  refine ⟨fun ctx s w h => Root12.full_supplement.h5.1 ctx s w ((clear_iff rfl).mp h),?_⟩
  intro ctx s w keys valid
  obtain ⟨sane,⟨event,sigs⟩ | ⟨_,_,_,_,ext,_⟩⟩ := valid
  · obtain ⟨route,shape,rfl⟩ := canonical event
    exact Root12.full_supplement.h5.2 ctx s w route shape sigs sane
  · exact False.elim (absentExtension ext)

namespace Bridge

theorem confinement {m : Model} (law : Confinement m) (pin : Root12.Grammar.Preserves Root12.Grammar.installed m) :
    Root12.H2 m := by
  have yes := (grows_of_pin pin).1 (by decide)
  exact fun ctx s xs stopped no => law ctx s xs stopped ((noClear_iff m yes ctx s xs).mpr no)

theorem recovery {m : Model} (law : Recovery m) (pin : Root12.Grammar.Preserves Root12.Grammar.installed m) :
    Root12.H5 m := by
  have yes := (grows_of_pin pin).1 (by decide)
  exact ⟨fun ctx s w valid => law.1 ctx s w ((clear_iff yes).mpr valid),
    fun ctx s w rt shape sigs keys => law.2 ctx s w _ ⟨keys,.inl ⟨recognized yes ⟨rt,shape,rfl⟩,sigs⟩⟩⟩

theorem clear_effect {m : Model} (law : ClearEffect m) (rec : Root12.Record m) : Root12.H3 m := by
  obtain ⟨_,table⟩ := rec.version.1
  have on_ : m.grammar.versionTwo = true := by rw [table]; rfl
  intro ctx s w t route ok
  obtain ⟨ff,ver⟩ := Root12.header route (by decide)
  obtain ⟨d,parsed⟩ := rec.parses ctx w s t ok
  have shape : Safe11.shape s w 51 = true := by
    by_contra no
    simp [Root12.Grammar.decode,ff,ver,on_,Root12.Grammar.second,route,no,guard] at parsed
    cases parsed
  exact law ctx s w t (recognized on_ ⟨route,shape⟩) ok

end Bridge

open private RootFinal.Paired.ordinaryFull RootFinal.Paired.checks from Proofs.FinalAdvice
open private Release.submitted from Proofs.RawRecord
open private SessionFinal.room from SessionFinal

/-- The old binding port runs the full independent Policy9 reference checks,
    including its owner credentials and nonce requirements, before being
    eligible for the same bounded recovery reserve as the dedicated 02 port. -/
theorem legacy_reserved {ctx : Context} {q : SessionFinal.Quota} {s w p n keys ed ml t}
    (open_ : q.closed = false) (room : q.reserved < SessionFinal.reserveSlots) (size : w.size ≤ Bounds12.maxInput)
    (tag : Tagged w 20) (decoded : Policy9.decode w = some (.rebind p n keys ed ml))
    (valid : Policy9.step w s = some t) :
    ∃ q', SessionFinal.frame fullModel ctx q s w = some (q',t) ∧ owner t = keys ∧ pool t = [] ∧
      Policy9.generation t = Policy9.generation s + 1 ∧ Safe11.halted t = Safe11.halted s ∧
      Hybrid7.Both Core8.verifiers (owner s) (Hybrid7.rebindMessage (owner s) (Policy9.generation s) keys) ed ml := by
  have nonInstall : ¬Tagged w 27 := by change w[0]? ≠ some (27 : UInt8); rw [tag]; decide
  have legacy : Legacy w := by change w[0]? ≠ some (255 : UInt8); rw [tag]; decide
  have routed : Safe11.route w = .ordinary := by simp [Safe11.route,tag]
  have kind : SessionFinal.candidateRecovery w = true := by simp [SessionFinal.candidateRecovery,routed,tag,decoded]
  obtain ⟨q',charged⟩ := SessionFinal.room open_ room size kind
  have core : Core9.step ctx w s = some t := by simpa [Core9.step,nonInstall] using valid
  have full := RootFinal.Paired.ordinaryFull legacy ctx s
  have step : fullModel.step ctx w s = some t := by
    change fullModel.step ctx w s = _ at full
    rw [full]
    simp [RootFinal.Paired.checks,Ratchet11.allow_ordinary (ctx := ctx) (s := s) nonInstall,
      Safe11.allowedOrdinary,Safe11.allowedCommand,decoded,core]
  obtain ⟨binding,sigs⟩ := newest_binding.2 ctx w s t p n keys ed ml ⟨nonInstall,decoded⟩ core
  have clear := Policy9.rebind_clears decoded valid
  exact ⟨q',by simp [SessionFinal.frame,charged,step],binding,clear.2.1,clear.2.2.1,
    by simp [Safe11.halted,Release.submitted core,Safe11.flagAfter,routed],sigs⟩

#print axioms legacy_reserved
end Aukora.RootFinal.Historical
