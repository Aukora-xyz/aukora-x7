import SessionFinal
import Proofs.FinalStep

namespace Aukora.SessionFinal
open Safe11 (fullModel)
open private Safe11.needs_owner from Proofs.Safe11

/-- Each of the three public routes eligible for the reserve checks both
    current keys. The two rebinding envelopes sign their respective messages. -/
def SignedRecovery (s : Release.State) (w : ByteArray) : Prop :=
  Safe11.ValidClear s w ∨
  (Safe11.route w = .rebind ∧ Safe11.shape s w 53 = true ∧ Safe11.Both s w 53 ∧
    Hybrid7.validKey (Safe11.newKeys s w) = true) ∨
  ∃ p n keys ed ml, Release.Tracked w (.rebind p n keys ed ml) ∧
    Hybrid7.Both Core8.verifiers (Release.owner s)
      (Hybrid7.rebindMessage (Release.owner s) (Policy9.generation s) keys) ed ml

theorem signed_at_limit {ctx q s w q' t} (full : ordinaryFits q.entries q.bytes w.size = false)
    (ok : frame fullModel ctx q s w = some (q',t)) :
    SignedRecovery s w ∧ q'.reserved = q.reserved + 1 := by
  obtain ⟨kind,hit,count⟩ := reserve_owner_only full ok
  refine ⟨?_,count⟩
  cases r : Safe11.route w with
  | clear => exact Or.inl (Safe11.needs_owner r hit)
  | rebind =>
    obtain ⟨_,raw,_⟩ := Option.map_eq_some'.mp hit
    simp only [Safe11.raw,r] at raw
    split at raw
    · rename_i valid
      simp only [Bool.and_eq_true] at valid
      obtain ⟨owner,keys⟩ := valid
      obtain ⟨shape,both⟩ := (Safe11.owner_iff ..).mp owner
      exact Or.inr (Or.inl ⟨r,shape,both,keys⟩)
    · contradiction
  | ordinary | halt | refusal =>
    all_goals
      by_cases tag : w[0]? = some (20 : UInt8)
      · cases dec : Policy9.decode w with
        | none => simp [candidateRecovery,r,tag,dec] at kind
        | some cmd =>
          cases cmd <;> simp [candidateRecovery,r,tag,dec] at kind
          rename_i p n keys ed ml
          have tr : Release.Tracked w (.rebind p n keys ed ml) := ⟨by simp [tag],dec⟩
          exact Or.inr (Or.inr ⟨p,n,keys,ed,ml,tr,
            (Release.newest_binding.2 ctx w s t p n keys ed ml tr (RootFinal.legacy_tracked tr hit)).2⟩)
      · simp [candidateRecovery,r,tag] at kind

theorem stamp_cannot_use_reserve {m q s w} (full : ordinaryFits q.entries q.bytes w.size = false) :
    stamp m q s w = none := by simp [stamp,charge,full]

theorem reserve_byte_bound (sizes : List Nat) (count : sizes.length ≤ reserveSlots)
    (bounded : ∀ n ∈ sizes, n ≤ Bounds12.maxInput) : sizes.sum ≤ reserveBytes := by
  have general (xs : List Nat) (h : ∀ n ∈ xs, n ≤ Bounds12.maxInput) :
      xs.sum ≤ xs.length * Bounds12.maxInput := by
    induction xs with
    | nil => simp
    | cons x xs ih =>
      simp only [List.sum_cons,List.length_cons,Nat.add_mul,Nat.one_mul]
      have one := h x (by simp)
      have rest := ih (fun n mem => h n (List.mem_cons_of_mem _ mem))
      omega
  exact Nat.le_trans (general sizes bounded) (Nat.mul_le_mul_right _ count)

#print axioms signed_at_limit
#print axioms stamp_cannot_use_reserve
#print axioms reserve_byte_bound
end Aukora.SessionFinal
