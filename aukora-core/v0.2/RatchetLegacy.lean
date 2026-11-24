import Refinement11
import RatchetModel

namespace Aukora.Ratchet11
open Release
open R6.KernelCell (Context)
open private Advice7.Pair Advice7.pairGet Advice7.InnerEq.mk Advice7.InnerEq.led Advice7.InnerEq.stage
  Advice7.LedgerEq.book from Proofs.Advice
open private Advice.Equiv Advice.Equiv.refl Advice.Equiv.mk Advice.BaseEq.mk Advice.one
  Advice.stampOne Advice.pairedVerdict Advice.Equiv.toBaseEq Advice.Equiv.rules Advice.Equiv.findings
  Advice.BaseEq.inner Advice.BaseEq.keys Advice.BaseEq.risk from Proofs.AdvicePolicy
open private Release.submitted from Proofs.RawRecord

private theorem other_update {w : ByteArray} (p) (tag : w[0]? ≠ some (27 : UInt8)) :
    update p w = p := by
  have d : Upgrade9.decode w = none := by simp [Upgrade9.decode, guard, tag]
  simp [update,d,Option.orElse]

private theorem two_ordinary {s t wx wy ctx} (pin : current s = current t)
    (tx : wx[0]? ≠ some (27 : UInt8)) (ty : wy[0]? ≠ some (27 : UInt8)) :
    allow ctx wx s = allow ctx wy t ∧ update (current s) wx = update (current t) wy := by
  rw [allow_ordinary tx, allow_ordinary ty, other_update _ tx, other_update _ ty, pin]
  exact ⟨rfl,rfl⟩

private theorem alignedChecks {s t wx wy ctx} (pin : current s = current t)
    (pair : Advice.Matched s t wx wy) :
    allow ctx wx s = allow ctx wy t ∧ update (current s) wx = update (current t) wy := by
  cases pair with
  | install x y tx ty dx dy hx hy target m cert intent =>
    refine ⟨allows_match pin tx ty dx dy m cert, ?_⟩
    simp [update,dx,dy,packagePin,m,cert,pin]
  | ordinary _ _ _ _ dx dy | rebind _ _ _ _ _ _ _ _ _ dx dy | report _ _ _ _ _ _ _ dx dy
    | use _ _ _ _ dx dy | issue _ _ _ _ _ _ _ _ _ _ dx dy | cancel _ _ _ _ _ _ _ _ _ dx dy
    | assessment _ _ _ _ _ dx dy | threshold _ _ _ _ _ dx dy =>
    exact two_ordinary pin dx.1 dy.1

private theorem framePair {s t wx wy ctx} (h : Advice.Equiv s t) (pin : current s = current t)
    (pair : Advice.Matched s t wx wy) :
    Advice7.Pair Advice.Equiv (model.step ctx wx s) (model.step ctx wy t) ∧
    current (execute model ctx s (.frame wx)) = current (execute model ctx t (.frame wy)) := by
  obtain ⟨same, changePin⟩ := alignedChecks (ctx := ctx) pin pair
  cases left : allow ctx wx s with
  | false =>
    have right := left ▸ same
    simpa [execute,model,step,left,right.symm] using And.intro (Advice7.Pair.none (r := Advice.Equiv)) pin
  | true =>
    have right := left ▸ same
    obtain paired := Advice.one (ctx := ctx) h pair
    refine ⟨by simpa [model,step,left,right.symm,newest] using paired, ?_⟩
    cases x : Core9.step ctx wx s with
    | none =>
      cases y : Core9.step ctx wy t with
      | none => simpa [execute,model,step,left,right.symm,x,y] using pin
      | some v => rw [x,y] at paired; cases paired
    | some u =>
      cases y : Core9.step ctx wy t with
      | none => rw [x,y] at paired; cases paired
      | some v =>
        have xe := current_push (Release.submitted x)
        have ye := current_push (Release.submitted y)
        simpa [execute,model,step,left,right.symm,x,y] using xe.trans (changePin.trans ye.symm)

private theorem stampPin (s : Release.State) (w : ByteArray) :
    current ((model.stamp w s).getD s) = current s := by
  cases ok : model.stamp w s with
  | none => rfl
  | some v =>
    obtain ⟨_, eq⟩ := newest_stamp w s v ok
    simp [eq,current]

private theorem trace {s t xs ys ctx} (a : Advice.Aligned model ctx s t xs ys)
    (h : Advice.Equiv s t) (pin : current s = current t) :
    Advice.Equiv (run model ctx s xs) (run model ctx t ys) ∧
      Advice.verdicts model ctx s xs = Advice.verdicts model ctx t ys := by
  induction a with
  | nil => exact ⟨h,rfl⟩
  | frame pair _ ih =>
    obtain ⟨paired, p⟩ := framePair (ctx := ctx) h pin pair
    have tail := ih (Advice7.pairGet paired h) p
    refine ⟨tail.1,?_⟩
    simp only [Advice.verdicts,tail.2,List.cons.injEq,and_true]; exact Advice.pairedVerdict paired
  | feed _ ih =>
    obtain ⟨⟨inner,keys,risk⟩,rules,findings⟩ := h
    have ledgerEq := Advice7.InnerEq.led inner
    exact ih (Advice.Equiv.mk (Advice.BaseEq.mk (Advice7.InnerEq.mk ledgerEq
      (congrArg (· ++ _) (Advice7.InnerEq.stage inner))) keys risk) rules findings) pin
  | reset _ ih =>
    obtain ⟨⟨inner,keys,risk⟩,rules,findings⟩ := h
    have ledgerEq := Advice7.InnerEq.led inner
    exact ih (Advice.Equiv.mk (Advice.BaseEq.mk (Advice7.InnerEq.mk ledgerEq rfl) keys risk)
      rules findings) pin
  | @stamp s t wx wy _ _ _ ih =>
    have left := Advice.stampOne s wx
    have right := Advice.stampOne t wy
    apply ih
    · change Advice.Equiv ((newest.stamp wx s).getD s) ((newest.stamp wy t).getD t)
      constructor
      · constructor
        · rw [left.1,right.1]; exact (Advice.BaseEq.inner (Advice.Equiv.toBaseEq h))
        · rw [left.1,right.1]; exact (Advice.BaseEq.keys (Advice.Equiv.toBaseEq h))
        · exact left.2.1.trans ((Advice.BaseEq.risk (Advice.Equiv.toBaseEq h)).trans right.2.1.symm)
      · exact left.2.2.1.trans ((Advice.Equiv.rules h).trans right.2.2.1.symm)
      · exact left.2.2.2.trans ((Advice.Equiv.findings h).trans right.2.2.2.symm)
    · exact (stampPin s wx).trans (pin.trans (stampPin t wy).symm)

theorem legacy_lawful : Release.Lawful model := by
  apply Release.Restriction11.lawful (accept := allow) (fun _ _ _ => allow_ordinary)
  intro ctx s xs ys aligned
  obtain ⟨paired, verdicts⟩ := trace aligned (Advice.Equiv.refl s) rfl
  exact ⟨Prod.ext (Advice.BaseEq.keys (Advice.Equiv.toBaseEq paired))
    (congrArg Book.auth (Advice7.LedgerEq.book (Advice7.InnerEq.led (Advice.BaseEq.inner (Advice.Equiv.toBaseEq paired))))), verdicts⟩

#print axioms legacy_lawful
end Aukora.Ratchet11
