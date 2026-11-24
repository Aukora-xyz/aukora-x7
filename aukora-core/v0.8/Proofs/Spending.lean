import Proofs.Authority
import Proofs.Stamp

namespace Aukora.Release
open R6.KernelCell (Context)
open private Upgrade9.install_ok from Gate
open private Core8.act from Ledger.Assessed
open private RiskWire8.act_ok from Proofs.DangerWire
open private Policy9.applyBase from Policy
open private Policy9.ran from Proofs.Policy

/-- A direct use has the grant route in the bundled delivery envelope, or is a package install. -/
def Direct (w : ByteArray) (i : Intent) : Prop :=
  (Tracked w (.use i) ∧ ∃ x, Wire5.decode (w.extract 33 w.size) = some x ∧ x.project.action = .base (.act i)) ∨
  (w[0]? = some (27 : UInt8) ∧ ∃ u, Upgrade9.decode w = some u ∧ u.intent = i)

def withoutIssue (m : Ops) (ctx : Context) (s : State) (i : Intent) : List Input → Prop
  | [] => True
  | c :: cs => (match c with
      | .frame w => ∀ t, m.step ctx w s = some t → ¬ Issued s w i
      | _ => True) ∧ withoutIssue m ctx (execute m ctx s c) i cs

def OnceLaw (m : Ops) : Prop :=
  ∀ ctx w s t i, m.step ctx w s = some t → Direct w i →
    i ∈ pool s ∧ i.generation = Policy9.generation s ∧
    (ledger t).book.auth.admitted = i :: (ledger s).book.auth.admitted ∧ i ∉ pool t ∧
    ∀ xs later, withoutIssue m ctx t i xs → Direct later i → m.step ctx later (run m ctx t xs) = none

private theorem consumed {ctx w s t i} (ok : newest.step ctx w s = some t) (direct : Direct w i) :
    i ∈ pool s ∧ i.generation = Policy9.generation s ∧
    (ledger t).book.auth.admitted = i :: (ledger s).book.auth.admitted ∧ i ∉ pool t := by
  have bound : ∃ f e, f.action = .base e ∧ spendIntent e = some i ∧
      R2.next (fun _ => Bound4.digest w) (ledger s) f = some (ledger t) := by
    rcases direct with ⟨cmd,x,dec,action⟩ | ⟨tag,u,dec,rfl⟩
    · have p := policy_step cmd ok
      have a := (Policy9.ran cmd.2 p).1
      have eligible := Policy9.use_requires_permission cmd.2 p
      simp only [Policy9.applyBase, eligible, if_true, Option.map_eq_some'] at a
      obtain ⟨b, act, eq⟩ := a
      obtain ⟨y, j, g, dy, _, hn, _⟩ := RiskWire8.act_ok act
      cases Option.some.inj (dy.symm.trans dec)
      exact ⟨_,_,action,rfl, by unfold ledger; rw [← eq]; exact (Bound4.accepted hn).2⟩
    · obtain ⟨v, dv, _, install, _⟩ := Core9.package_admission tag ok
      cases Option.some.inj (dv.symm.trans dec)
      exact ⟨_,_,rfl,rfl,(Bound4.accepted (Upgrade9.install_ok install).2.2).2⟩
  obtain ⟨f,e,ev,sp,hn⟩ := bound
  obtain ⟨allowed, next⟩ := R2.next_spec hn
  have eligible : Eligible (ledger s).book e := by simpa [ev,R2.policy] using allowed.2.2.1
  have held : i ∈ pool s ∧ i.generation = Policy9.generation s := by simpa [spendOK,sp] using eligible.1
  refine ⟨held.1, held.2, ?_⟩
  change (ledger t).book.auth.admitted = _ ∧ i ∉ (ledger t).book.auth.grants
  cases e <;> simp [spendIntent] at sp
  all_goals subst i; simp [next, R2.append, R2.nextBook, advance, changeAuth, spend, ev, List.mem_filter]

private theorem remainsAbsent (ctx s xs i) (absent : i ∉ pool s) (noNew : withoutIssue newest ctx s i xs) :
    i ∉ pool (run newest ctx s xs) := by
  induction xs generalizing s with
  | nil => exact absent
  | cons c cs ih =>
    apply ih (execute newest ctx s c) _ noNew.2
    cases c with
    | feed | reset => exact absent
    | stamp w =>
      cases ok : Core8.stamp w s.base with
      | none => simpa [execute,newest,Core9.stamp,ok] using absent
      | some b => simpa [execute,newest,Core9.stamp,ok,(Stamp8.accepted ok).2] using absent
    | frame w =>
      cases ok : newest.step ctx w s with
      | none => simpa [execute,ok] using absent
      | some t =>
        intro held
        have after : i ∈ pool t := by simpa [execute,ok] using held
        exact noNew.1 t ok (newest_grant ctx w s t i ok absent after)

theorem newest_once : OnceLaw newest := by
  intro ctx w s t i ok direct
  obtain ⟨held,gen,admitted,absent⟩ := consumed ok direct
  refine ⟨held,gen,admitted,absent,?_⟩
  intro xs later noNew use
  cases h : newest.step ctx later (run newest ctx t xs) with
  | none => rfl
  | some u => exact False.elim ((remainsAbsent ctx t xs i absent noNew) (consumed h use).1)

end Aukora.Release
