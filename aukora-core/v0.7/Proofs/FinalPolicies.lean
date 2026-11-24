import Proofs.FinalHistory
import Proofs.Versions
import Proofs.FinalAdvice
import Proofs.InstalledEvidence
namespace Aukora.RootFinal
open Release
open Safe11 (fullModel)
open Versions
open R6.KernelCell (Context)
open private Paired.ordinaryFull Paired.checks from Proofs.FinalAdvice
open private Versions.legacyParsed Versions.controlParsed Versions.evidenceParsed from Versions
open private Policy9.applyBase from Policy
open private Core8.slice from Ledger.Assessed

def slotAction (d : Root12.Grammar.Decoded) : ExtensionKind → Prop
  | .passive =>
    match d.frame.action with
    | .base (.say ..) | .base (.remember ..) | .base (.correct ..) | .base (.advise ..) => True
    | _ => False
  | .report i v _ => d.frame.action = .base (.outcome i v)
  | .assessment .. => ∃ name n, d.frame.action = .base (.advise name n)
  | .threshold p n _ _ _ | .cancel p n _ _ _ =>
    d.frame.parent = p ∧ d.frame.seq = n ∧ ∃ name score, d.frame.action = .base (.advise name score)
  | .issue p n _ i _ _ => d.frame = ⟨p,n,.base (.grant i true)⟩
  | .rebind p n keys _ _ => d.frame = ⟨p,n,.base (.rebind (Wire5.keyName keys.ed) true)⟩

structure Record (m : Model) : Prop extends Root12.Record m where
  consistent : ∀ ctx w s t d v raw op, m.step ctx w s = some t →
    Root12.Grammar.decode m.grammar s w = some d → d.payload = .later v raw op → slotAction d op

theorem full_record : Record fullModel := ⟨Root12.full_record,by
  intro ctx w s t d v raw op hit dec later
  apply False.elim
  apply no_extension hit op
  simp [interpretations,dec,meaning,later]⟩

/-- The legacy non-install port preserves the baseline verdict except for the
    explicit halt boundary and checked evidence required for a bundled act.
    Installs have their own old-format obligations in L8 and succession. -/
def PriorVerdicts (m : Model) : Prop :=
  ∀ ctx w s, Legacy w → w[0]? ≠ some (27 : UInt8) →
    (m.step ctx w s).isSome =
      if !(Safe11.halted s && !Safe11.allowedOrdinary w) &&
          (match Policy9.decode w with | some (.use i) => Historical.allows m.grammar s w i | _ => true)
      then (Policy9.step w s).isSome else false

theorem full_prior_verdicts : PriorVerdicts fullModel := by
  intro ctx w s old nonInstall
  simp only [Historical.full_allows]
  have h := Paired.ordinaryFull old ctx s
  change fullModel.step ctx w s = _ at h
  have ref : Core9.step ctx w s = Policy9.step w s := by simp [Core9.step,nonInstall]
  cases gate : Paired.checks ctx s w with
  | true =>
    rw [h,gate,if_pos rfl,ref]
    simp only [Paired.checks,Ratchet11.allow_ordinary (ctx := ctx) (s := s) nonInstall,Bool.true_and] at gate
    cases d : Policy9.decode w with
    | none => simp [d] at gate; simp [gate]
    | some cmd => cases cmd <;> simp only [d] at gate <;> simp_all only [Bool.and_true,if_true]
  | false =>
    rw [h,gate,if_neg (by decide)]
    simp only [Paired.checks,Ratchet11.allow_ordinary (ctx := ctx) (s := s) nonInstall,Bool.true_and] at gate
    cases d : Policy9.decode w with
    | none => simp [d] at gate; simp [gate]
    | some cmd => cases cmd <;> simp only [d] at gate <;> simp_all only [Bool.and_true,Bool.false_eq_true,if_false,Option.isSome_none]

/-- The installed interpretation names an issue, and its message verifies under both owner keys. -/
def NewIssue (m : Model) (s : Release.State) (w : ByteArray) (i : Intent) : Prop :=
  ∃ p n e ed ml, interpretations m.grammar s w = some (.extension (.issue p n e i ed ml)) ∧
    Hybrid7.Both Core8.verifiers (owner s) (Policy9.issueMessage s p n e i) ed ml

def without (m : Model) (ctx : Context) (P : Release.State → ByteArray → Prop) (s : Release.State) : List Input → Prop
  | [] => True
  | c :: cs => (match c with
      | .frame w => ∀ t, m.step ctx w s = some t → ¬P s w
      | _ => True) ∧ without m ctx P (execute m ctx s c) cs

private theorem noIssue_old {m ctx s i xs} (h : without m ctx (fun a w => Issued a w i ∨ NewIssue m a w i) s xs) :
    withoutIssue m ctx s i xs := by
  induction xs generalizing s with
  | nil => trivial
  | cons c cs ih =>
    refine ⟨?_,ih h.2⟩
    cases c with
    | frame w => exact fun t ok issued => h.1 t ok (.inl issued)
    | _ => trivial

private theorem noRenewal_old {m ctx s i xs} (h : without m ctx (fun a w => Policy9.Fresh a w i ∨ NewIssue m a w i) s xs) :
    withoutRenewal m ctx s i xs := by
  induction xs generalizing s with
  | nil => trivial
  | cons c cs ih =>
    refine ⟨?_,ih h.2⟩
    cases c with
    | frame w => exact fun t ok issued => h.1 t ok (.inl issued)
    | _ => trivial

def Once (m : Model) : Prop :=
  ∀ ctx w s t i, m.step ctx w s = some t → Direct w i →
    i ∈ pool s ∧ i.generation = Policy9.generation s ∧
    (ledger t).book.auth.admitted = i :: (ledger s).book.auth.admitted ∧ i ∉ pool t ∧
    ∀ xs later, without m ctx (fun a z => Issued a z i ∨ NewIssue m a z i) t xs →
      Direct later i → m.step ctx later (run m ctx t xs) = none

theorem full_once_installed : Once fullModel := by
  intro ctx w s t i h direct
  obtain ⟨a,b,c,d,all⟩ := full_once ctx w s t i h direct
  exact ⟨a,b,c,d,fun xs later no => all xs later (noIssue_old no)⟩

def Timed (m : Model) (s : Release.State) (w : ByteArray) (p : Digest) (n last : Nat) (i : Intent) (ed ml : Bytes) : Prop :=
  Tracked w (.issue p n last i ed ml) ∨ interpretations m.grammar s w = some (.extension (.issue p n last i ed ml))

def Expiry (m : Model) : Prop :=
  (∀ ctx w s t p n last i ed ml, Timed m s w p n last i ed ml → m.step ctx w s = some t →
    Hybrid7.Both Core8.verifiers (owner s) (Policy9.issueMessage s p n last i) ed ml ∧
    n < last ∧ i ∈ pool t ∧ Policy9.lookup i t.rules = some (.validThrough last) ∧
    ∀ proposed, Policy9.permits t.rules i proposed = decide (proposed ≤ last)) ∧
  (∀ ctx w s i, (Policy9.lookup i s.rules = some .revoked ∨
     ∃ last, Policy9.lookup i s.rules = some (.validThrough last) ∧ last < Policy9.nextSeq s) →
    Core9PolicyLaws.spends w i → m.step ctx w s = none) ∧
  ∀ ctx s i xs w, Policy9.Closed s i → without m ctx (fun a z => Policy9.Fresh a z i ∨ NewIssue m a z i) s xs →
    Core9PolicyLaws.spends w i → m.step ctx w (run m ctx s xs) = none

theorem full_expiry_installed : Expiry fullModel := by
  refine ⟨?_,full_expiry.2.1,fun ctx s i xs w closed no => full_expiry.2.2 ctx s i xs w closed (noRenewal_old no)⟩
  intro ctx w s t p n last i ed ml input ok
  exact full_expiry.1 ctx w s t p n last i ed ml (input.resolve_right (no_extension ok _)) ok

def Cancel (m : Model) (s : Release.State) (w : ByteArray) (p : Digest) (n : Nat) (d : Digest) (ed ml : Bytes) : Prop :=
  Tracked w (.cancel p n d ed ml) ∨ interpretations m.grammar s w = some (.extension (.cancel p n d ed ml))

def Control (m : Model) : Prop := ControlLaw m ∧
  ∀ ctx w s t p n d ed ml, Cancel m s w p n d ed ml → m.step ctx w s = some t →
    Hybrid7.Both Core8.verifiers (owner s) (Policy9.cancelMessage s p n d) ed ml

theorem full_control_installed : Control fullModel := ⟨full_control,fun ctx w s t p n d ed ml cancel ok =>
  full_control.2 ctx w s t p n d ed ml (cancel.resolve_right (no_extension ok _)) ok⟩

def Revocation (m : Model) : Prop :=
  ∀ ctx w s t p n d ed ml, Cancel m s w p n d ed ml → m.step ctx w s = some t →
    p = (ledger s).head ∧ n = Policy9.nextSeq s ∧ Policy9.generation t = Policy9.generation s ∧
    ∃ victim, Policy9.matchingGrants s d = [victim] ∧
      (∀ j, j ∈ pool t ↔ j ∈ pool s ∧ j ≠ victim) ∧
      Policy9.lookup victim t.rules = some .revoked ∧
      (∀ j, j ≠ victim → Policy9.lookup j t.rules = Policy9.lookup j s.rules)

theorem full_revocation : Revocation fullModel := fun ctx w s t p n d ed ml cancel ok =>
  full_revoke ctx w s t p n d ed ml (cancel.resolve_right (no_extension ok _)) ok

def MarkedReport (m : Model) (s : Release.State) (w : ByteArray) (i : Intent) (val : Result) (fix : Bool) : Prop :=
  (∃ p n, Tracked w (.report p n i val fix)) ∨
  (∃ confidence, interpretations m.grammar s w = some (.evidence (.outcome i val fix confidence))) ∨
   interpretations m.grammar s w = some (.extension (.report i val fix))

def Correction (m : Model) : Prop :=
  (∀ s key, m.outcome s key = Policy9.outcomeCode s key) ∧
  ∀ ctx w s t i v fix, MarkedReport m s w i v fix → m.step ctx w s = some t →
    Policy9.reportOK s.outcomes i fix = true ∧
    t.outcomes = ⟨Risk8.intentDigest i,i,v,fix⟩ :: s.outcomes ∧
    ∀ key, Digest.mk key.data.toList = Risk8.intentDigest i →
      m.outcome t key = (if fix then 4 else 0) + (match v with | .confirmed => 0 | .failed => 1 | .unknown => 2)

theorem full_correction_installed : Correction fullModel := by
  refine ⟨fun _ _ => rfl,?_⟩
  intro ctx w s t i v fix marked ok
  have info : Policy9.reportOK s.outcomes i fix = true ∧ t.outcomes = ⟨Risk8.intentDigest i,i,v,fix⟩ :: s.outcomes := by
    rcases marked with ⟨p,n,legacy⟩ | ⟨val,printed⟩ | future
    · have inner := policy_step legacy (legacy_tracked legacy ok)
      have step : Policy9.submit s w (.report p n i v fix) = some t := by simpa [Policy9.step,legacy.2] using inner
      obtain ⟨b,apply,eq⟩ := Option.bind_eq_some.mp step
      cases Option.some.inj eq
      obtain ⟨_,guarded,_⟩ := Option.bind_eq_some.mp apply
      refine ⟨?_,rfl⟩
      by_cases valid : Policy9.reportOK s.outcomes i fix = true
      · exact valid
      · simp [guard,valid] at guarded
    · cases dispatch ok with
      | legacy old => rw [Versions.legacyParsed old] at printed; cases printed
      | evidence ff rt dec applied =>
        rw [Versions.evidenceParsed ff rt dec] at printed
        have same := Versions.Meaning.evidence.inj (Option.some.inj printed)
        simp only [Evidence11.submit,same] at applied
        obtain ⟨b,app,eq⟩ := Option.bind_eq_some.mp applied
        cases Option.some.inj eq
        obtain ⟨_,guarded,_⟩ := Option.bind_eq_some.mp app
        refine ⟨?_,rfl⟩
        by_cases valid : Policy9.reportOK s.outcomes i fix = true
        · exact valid
        · simp [guard,valid] at guarded
      | note ff special noKey => rw [Versions.controlParsed ok special,if_neg noKey] at printed; cases printed
      | rebind ff rt _ _ => rw [Versions.controlParsed ok (by simp [rt]),if_pos rt] at printed; cases printed
    · exact False.elim (no_extension ok _ future)
  refine ⟨info.1,info.2,?_⟩
  intro key id
  change Policy9.outcomeCode t key = _
  cases v <;> simp [Policy9.outcomeCode,info.2,id,Policy9.view]

def haltAllowed (m : Model) (s : Release.State) (w : ByteArray) : Prop :=
  Safe11.allowedOrdinary w = true ∨ ∃ op, interpretations m.grammar s w = some (.extension op) ∧
    match op with
    | .passive => Evidence11.decode (Historical.wire m.grammar w) = none ∧
        ∃ d, Root12.Grammar.decode m.grammar s w = some d ∧
          match d.frame.action with
          | .base (.say ..) | .base (.remember ..) | .base (.advise ..) => True
          | _ => False
    | .cancel .. | .rebind .. | .report .. | .threshold .. => True
    | _ => False

def Boundary (m : Model) : Prop :=
  ∀ ctx w s, Safe11.halted s = true → Safe11.route w = .ordinary → ¬haltAllowed m s w → m.step ctx w s = none

theorem full_boundary : Boundary fullModel := by
  intro ctx w s halted route barred
  have raw : Safe11.allowedOrdinary w = false := by
    cases h : Safe11.allowedOrdinary w with
    | false => rfl
    | true => exact False.elim (barred (.inl h))
  exact Root12.full_supplement.h1 ctx w s halted route raw

#print axioms full_prior_verdicts
#print axioms full_correction_installed
end Aukora.RootFinal
