import Proofs.FinalPolicies
import Proofs.InstalledRecovery

namespace Aukora.RootFinal
open Release
open Safe11 (fullModel)
open Versions
open R6.KernelCell (Context)
open private Policy9.append from Policy
open private Evidence11.metadata from Evidence11
open private Versions.legacyParsed from Versions
open private RootFinal.noFuture from Proofs.Versions

namespace VersionAdvice

/-- The observation is independent of both the candidate admission function and
    the numeric value of ordinary advice. Assessment scores are risk inputs and
    are deliberately kept distinct from ordinary advisory scores. -/
def passiveBody : Evidence11.Body → Bool
  | .read .. | .source .. | .premise .. | .cell .. => true
  | _ => false

def validRange (e : Evidence11.Envelope) : Bool :=
  match e.body with
  | .read r => decide (r.first ≤ r.last ∧ r.last ≤ e.seq)
  | _ => true

def evidenceGate (s : Release.State) (w : ByteArray) (e : Evidence11.Envelope) : Bool :=
  !(Safe11.halted s && !Safe11.allowedOrdinary w) &&
    decide (e.parent = (ledger s).head ∧ e.seq = Policy9.nextSeq s) && validRange e

/-- The Bool matches the independently determined address, halt and range
    conditions on the two sides. Future passive-advice slots may encode the
    same cell with different numeric scores. No admission result is an input. -/
inductive Receipt (g : WireGrammar) (s : Release.State) (w : ByteArray) : Bool → Prop where
  | evidence (e : Evidence11.Envelope)
    (used : interpretations g s w = some (.evidence e.body))
    (route : Safe11.route w = .ordinary)
    (routed : (Evidence11.subtag w).any (fun t => 40 ≤ t && t ≤ 43) || (Evidence11.cellSubtag w).isSome)
    (parsed : Evidence11.decode w = some e) (quiet : passiveBody e.body = true) :
    Receipt g s w (evidenceGate s w e)
  | future (d : Root12.Grammar.Decoded) (v : UInt8) (name : String) (n : Nat)
    (parsed : Root12.Grammar.decode g s w = some d) (assigned : d.payload = .later v w .passive)
    (advice : d.frame.action = .base (.advise name n))
    (plain : Evidence11.decode (Historical.wire g w) = none) :
    Receipt g s w (decide (d.frame.parent = (ledger s).head ∧ d.frame.seq = Policy9.nextSeq s))

private theorem metadata_verdict (s : Release.State) (w : ByteArray) (e : Evidence11.Envelope) :
    (Evidence11.metadata s w e s.base.risk).isSome =
      decide (e.parent = (ledger s).head ∧ e.seq = Policy9.nextSeq s) := by
  let f : R2.Frame := ⟨e.parent,e.seq,.base (.advise "AUKORA/R11/evidence" 0)⟩
  have ha : R2.Allowed (ledger s) f ↔ e.parent = (ledger s).head ∧ e.seq = Policy9.nextSeq s := by
    simp [R2.Allowed,f,R2.policy,Eligible,spendOK,spendIntent,eventOK,R2.withinLimit,R2.debit,Policy9.nextSeq,ledger]
  by_cases good : R2.Allowed (ledger s) f
  · have pass := ha.mp good
    rw [decide_eq_true pass]
    simp [Evidence11.metadata,Policy9.append,Bound4.next,Bound4.candidateOK,R2.next,
      show R2.Allowed s.base.hybrid.inner.ledger ⟨e.parent,e.seq,.base (.advise "AUKORA/R11/evidence" 0)⟩ from good]
  · have no := mt ha.mpr good
    simp only [Evidence11.metadata,Policy9.append,Bound4.next,Bound4.candidateOK,if_true,R2.next]
    simp [show ¬R2.Allowed s.base.hybrid.inner.ledger ⟨e.parent,e.seq,.base (.advise "AUKORA/R11/evidence" 0)⟩ from good,no]


private theorem submit_verdict {s : Release.State} {w : ByteArray} {e : Evidence11.Envelope}
    (quiet : passiveBody e.body = true) :
    (Evidence11.submit s w e).isSome =
      (decide (e.parent = (ledger s).head ∧ e.seq = Policy9.nextSeq s) && validRange e) := by
  obtain ⟨p,n,b⟩ := e
  cases b <;> simp [passiveBody] at quiet
  all_goals simp only [Evidence11.submit,validRange]
  all_goals first | exact (metadata_verdict s w _).trans (Bool.and_true _).symm | skip
  split <;> simp_all [metadata_verdict] <;> grind

private theorem metadata_auth {s : Release.State} {w e t}
    (ok : Evidence11.metadata s w e s.base.risk = some t) : auth (recordPush s w t) = auth s := by
  obtain ⟨b,app,eq⟩ := Option.bind_eq_some.mp ok
  cases Option.some.inj eq
  obtain ⟨inner,bound,eq⟩ := Option.bind_eq_some.mp app
  cases Option.some.inj eq
  have led := (R2.next_spec (Bound4.accepted bound).2).2
  exact Prod.ext rfl (by change inner.ledger.book.auth = _; rw [led]; rfl)

private theorem receive {s w ok} (ctx : Context) (h : Receipt fullModel.grammar s w ok) :
    (fullModel.step ctx w s).isSome = ok ∧ auth (execute fullModel ctx s (.frame w)) = auth s := by
  cases h with
  | future d v name n parsed assigned _ _ => exact False.elim (RootFinal.noFuture parsed assigned)
  | evidence e used route routed parsed quiet =>
    have notAct : w[0]? ≠ some (23 : UInt8) := by
      intro tag
      simp [Evidence11.decode,Evidence11.subtag,Evidence11.cellSubtag,tag] at parsed
    constructor
    · cases h : (Safe11.halted s && !Safe11.allowedOrdinary w) <;>
        simp [fullModel,Round11.step,Safe11.step,Safe11.raw,route,h,Evidence11.step,
          Evidence11.routed,notAct,routed,parsed,evidenceGate,submit_verdict quiet]
    · cases hit : fullModel.step ctx w s with
      | none => simp [execute,hit]
      | some t =>
        simp only [execute,hit,Option.getD_some]
        cases dispatch hit with
        | legacy old => rw [Versions.legacyParsed old] at used; cases used
        | note _ special _ => exact False.elim (special route)
        | rebind _ rt _ _ => rw [rt] at route; contradiction
        | evidence _ _ de applied =>
          rw [parsed] at de
          cases Option.some.inj de
          obtain ⟨p,n,b⟩ := e
          cases b <;> simp [passiveBody] at quiet
          all_goals simp only [Evidence11.submit] at applied
          all_goals first | exact metadata_auth applied | split at applied <;> first | contradiction | exact metadata_auth applied

inductive Aligned (m : Model) (ctx : Context) :
    Release.State → Release.State → List Input → List Input → Prop where
  | nil : Aligned m ctx s t [] []
  | frame (left : Receipt m.grammar s w ok) (right : Receipt m.grammar t v ok)
      (tail : Aligned m ctx (execute m ctx s (.frame w)) (execute m ctx t (.frame v)) xs ys) :
      Aligned m ctx s t (.frame w :: xs) (.frame v :: ys)

end VersionAdvice

/-- Legacy aligned commands retain their full trace guarantee. From any
    equally authorized pair of prefixes, old or mixed, independently addressed
    installed passive receipts preserve authority and equal frame verdicts. -/
def VersionAdvice (m : Model) : Prop := AdviceLaw m ∧
  ∀ ctx s t xs ys, auth s = auth t → VersionAdvice.Aligned m ctx s t xs ys →
    auth (run m ctx s xs) = auth (run m ctx t ys) ∧
    Advice.verdicts m ctx s xs = Advice.verdicts m ctx t ys

theorem full_versionAdvice : VersionAdvice fullModel := by
  refine ⟨full_advice,?_⟩
  intro ctx s t xs ys equal paired
  induction paired with
  | nil => exact ⟨equal,rfl⟩
  | frame left right _ ih =>
    obtain ⟨lv,la⟩ := VersionAdvice.receive ctx left
    obtain ⟨rv,ra⟩ := VersionAdvice.receive ctx right
    obtain ⟨after_,tail⟩ := ih (la.trans (equal.trans ra.symm))
    exact ⟨after_,by simp [Advice.verdicts,lv,rv,tail]⟩

#print axioms full_versionAdvice
end Aukora.RootFinal
