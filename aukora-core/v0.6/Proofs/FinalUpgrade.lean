import Proofs.FullSuccession

namespace Aukora.RootFinal
open Release (Model ledger pool)
open R6.KernelCell (Context)

private theorem initialized_basis {snapshot ctx} (h : RatchetChecker.init snapshot = some ctx) :
    RatchetChecker.basis ctx = some (RatchetChecker.number (Sha256.hash snapshot)) := by
  unfold RatchetChecker.init at h
  obtain ⟨old,_,rest⟩ := Option.bind_eq_some.mp h
  obtain ⟨_,_,r⟩ := Option.bind_eq_some.mp rest
  cases Option.some.inj r
  rfl

private theorem same_basis {ctx prev b law} (h : Ratchet11.basisAndSet ctx prev = some (b,law)) :
    RatchetChecker.basis ctx = some b := by
  unfold Ratchet11.basisAndSet at h
  obtain ⟨k,hk,rest⟩ := Option.bind_eq_some.mp h
  cases prev with
  | none =>
    cases Option.some.inj rest
    exact hk
  | some pin =>
    obtain ⟨_,_,r⟩ := Option.bind_eq_some.mp rest
    cases Option.some.inj r
    exact hk

/-- The foundation and predecessor come from the running context and ledger.
    The loader type-checks the carried machine definitions before constructing
    the two independent goals. The C comparison of staged executable bytes
    is an additional condition on the Wasm entry point. -/
def PinnedChecks (ctx : Context) (s t : Release.State) (u : Upgrade9.Package) : Prop :=
  Ratchet11.Demands ctx s t u ∧
    ∀ bytes, RatchetChecker.init bytes = some ctx →
      ∃ child, RatchetChecker.spec u.model = some child ∧
        Ratchet11.current t = some (RatchetChecker.number (Sha256.hash bytes), child)

private theorem checked_pin {ctx s t u} (verified : Ratchet11.Demands ctx s t u) :
    PinnedChecks ctx s t u := by
  refine ⟨verified,?_⟩
  intro bytes initialized
  obtain ⟨b,law,cert,g,next,prev,_,_,_,spec,now,_⟩ := verified
  have eq := (same_basis prev).symm.trans (initialized_basis initialized)
  exact ⟨next,spec,Option.some.inj eq ▸ now⟩

/-- Protocol-independent safety evidence attached to the package selected by
    the installed parser on an admitted core change. -/
def PackageFacts (ctx : Context) (w : ByteArray) (s t : Release.State) (u : Upgrade9.Package) : Prop :=
  PinnedChecks ctx s t u ∧ Upgrade9.ownerBound u = true ∧
      Policy9.grantOK s u.intent = true ∧
      ModelSection9.read s.base.hybrid.inner.candidate = some (Bound4.digest u.model) ∧
      u.target = (ledger t).book.auth.core ∧ (ledger t).book.auth.core = Bound4.digest s.base.hybrid.inner.candidate ∧
      u.intent.body = .install u.target ∧ u.intent ∈ pool s ∧ u.intent ∉ pool t ∧
      t.base.record = s.base.record.push w ∧
      ∀ approved, u.intent.body = .install (Bound4.digest approved) →
        (Bound4.digest s.base.hybrid.inner.candidate = Bound4.digest approved → s.base.hybrid.inner.candidate = approved) →
        s.base.hybrid.inner.candidate = approved

/-- L8. An admitted core change commits the staged bytes, exact model and proof
    bytes, currently eligible grant, expenditure, and both checked law goals.
    Byte equality from equal content hashes uses the displayed hypothesis. -/
def Upgrade (m : Model) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t → (ledger t).book.auth.core ≠ (ledger s).book.auth.core →
    w[0]? = some (27 : UInt8) ∧ ∃ u, Upgrade9.decode w = some u ∧
      PackageFacts ctx w s t u

theorem full_upgrade : Upgrade Safe11.fullModel := by
  intro ctx w s t ok changed
  obtain ⟨tag,u,decoded,demands⟩ := Round11.full_core_change ok changed
  have hit := Round11.install_is_ratchet tag ok
  have allowed : Ratchet11.allow ctx w s = true := by
    by_contra no
    simp [Ratchet11.step,no] at hit
  have inner : Core9.step ctx w s = some t := by simpa [Ratchet11.step,allowed] using hit
  obtain ⟨v,decoded',eligible,run,_,_,record⟩ := Core9.package_admission tag inner
  have same := Option.some.inj (decoded.symm.trans decoded')
  subst v
  obtain ⟨commitment,_,staged,core,body,held,spent⟩ := Upgrade9.admission run
  exact ⟨tag,u,decoded,checked_pin demands,Ratchet11.allowed_owner_bound tag decoded allowed,
    eligible,commitment,staged.symm.trans core.symm,core,staged ▸ body,held,spent,record,
    fun _ other collision => collision (Body.install.inj (body.symm.trans other))⟩

#print axioms full_upgrade
end Aukora.RootFinal
