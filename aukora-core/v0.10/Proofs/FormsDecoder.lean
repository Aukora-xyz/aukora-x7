import Forms
import Proofs.RecordBinding

/-! Root v2 step 3a, step 3: the form table agrees with the machine's own decoder for the two forms
this step refuses. Without these, "the form is refused" would not mean "the effect cannot happen".
The decoder is `Policy9.decode`, the only path by which the full and lite steps admit either form:
- plain approval: `Policy9.decode w = some (.ordinary x (.signed pq))` with `x.action = .grant i sig`
  (the legacy grant, Wire5 action byte 03 under the single-ML-DSA-signature tag 13 hex);
- old key change: `Policy9.decode w = some (.rebind p n keys ed ml)` (tag 14 hex). -/

namespace Aukora.Forms
open private Policy9.full Policy9.issueFields Policy9.cancelFields from Policy

/-! ### The reader consumes exactly what it reads -/

theorem sbind {α β : Type} {x : Wire4.Reader α} {f : α → Wire4.Reader β} {l r : Bytes} {b : β}
    (h : (x >>= f) l = some (b, r)) : ∃ a l', x l = some (a, l') ∧ f a l' = some (b, r) := by
  change (StateT.bind x f) l = _ at h
  simp only [StateT.bind] at h
  cases hx : x l with
  | none => rw [hx] at h; cases h
  | some p =>
    obtain ⟨a, l'⟩ := p
    rw [hx] at h
    exact ⟨a, l', rfl, h⟩

theorem spure {α : Type} {a b : α} {l r : Bytes} (h : (pure a : Wire4.Reader α) l = some (b, r)) :
    a = b ∧ l = r := by
  change some (a, l) = some (b, r) at h
  cases h
  exact ⟨rfl, rfl⟩

theorem byte_some {l : Bytes} {b : UInt8} {r : Bytes} (h : Wire4.byte l = some (b, r)) : l = b :: r := by
  cases l with
  | nil => cases h
  | cons x xs => cases h; rfl

theorem uint_drop : ∀ (n : Nat) (l : Bytes) (v : Nat) (r : Bytes),
    Wire4.uint n l = some (v, r) → r = l.drop n
  | 0, l, v, r, h => (spure h).2.symm
  | n + 1, l, v, r, h => by
    unfold Wire4.uint at h
    obtain ⟨low, l1, hb, h⟩ := sbind h
    obtain ⟨v', l2, hu, h⟩ := sbind h
    obtain ⟨_, rfl⟩ := spure h
    rw [byte_some hb, List.drop_succ_cons]
    exact uint_drop n l1 v' l2 hu

theorem take_drop {n : Nat} {l a r : Bytes} (h : Wire4.takeBytes n l = some (a, r)) : r = l.drop n := by
  unfold Wire4.takeBytes at h
  dsimp only at h
  split at h
  · cases h; rfl
  · cases h

/-- The decoder's action field yields the legacy grant only from action byte 03. -/
theorem action_grant {l : Bytes} {i : Intent} {sig r : Bytes}
    (h : Wire5.actionField l = some (.grant i sig, r)) : l.head? = some 3 := by
  unfold Wire5.actionField at h
  obtain ⟨t, l1, hb, h⟩ := sbind h
  rw [byte_some hb, List.head?_cons]
  by_cases hk : t.toNat = 3
  · exact congrArg some (UInt8.toNat_inj.mp hk)
  · exfalso
    generalize hn : t.toNat = k at h
    split at h
    · exact hk hn
    all_goals
      repeat (first | (obtain ⟨_, _, _, h⟩ := sbind h) | (split at h) | (unfold Wire5.plainBase at h))
    all_goals first
      | (have e := (spure h).1; cases e)
      | (simp [Wire4.invalid] at h; done)
      | (simp_all [bind, StateT.bind, pure, StateT.pure, Option.bind_eq_some, Wire4.invalid]; done)
      | cases h

theorem frame_grant {l r : Bytes} {x : Wire5.Frame} {i : Intent} {sig : Bytes}
    (h : Wire5.frameField l = some (x, r)) (act : x.action = .grant i sig) : l[40]? = some 3 := by
  unfold Wire5.frameField at h
  obtain ⟨d, l1, hd, h⟩ := sbind h
  obtain ⟨n, l2, hn, h⟩ := sbind h
  obtain ⟨a, l3, ha, h⟩ := sbind h
  obtain ⟨eq, _⟩ := spure h
  subst eq
  unfold Wire4.digestField at hd
  obtain ⟨bs, l1', ht, hd⟩ := sbind hd
  have d1 : l1 = l.drop 32 := by rw [← (spure hd).2]; exact take_drop ht
  have d2 : l2 = l1.drop 8 := uint_drop 8 l1 n l2 hn
  simp only at act
  subst act
  have h3 := action_grant ha
  rw [d2, d1, List.drop_drop, List.head?_drop] at h3
  simpa using h3

theorem request_signed {w : ByteArray} {r : Hybrid7.Request} {pq : Bytes}
    (rq : Core8.request w = some r) (ex : r.extra = .signed pq) : w[0]? = some (19 : UInt8) := by
  cases h0 : w[0]? with
  | none => simp [Core8.request, h0] at rq
  | some t =>
    by_cases t0 : t = 0
    · subst t0; simp [Core8.request, h0] at rq; subst rq; cases ex
    by_cases t19 : t = 19
    · subst t19; rfl
    by_cases t20 : t = 20
    · subst t20
      simp [Core8.request, h0] at rq
      by_cases hs : 5262 ≤ w.size
      · simp [hs, guard] at rq; subst rq; cases ex
      · simp [hs, guard, failure] at rq
    · simp [Core8.request, h0, t0, t19, t20] at rq

theorem request_signed_wire {w : ByteArray} {r : Hybrid7.Request} (rq : Core8.request w = some r)
    (t : w[0]? = some (19 : UInt8)) : r.wire = w.extract (1 + 3309) w.size := by
  simp [Core8.request, t] at rq
  by_cases hs : 3310 ≤ w.size
  · simp [hs, guard] at rq; subst rq; rfl
  · simp [hs, guard, failure] at rq

theorem request_binding {w : ByteArray} {r : Hybrid7.Request} {a b : Bytes}
    (rq : Core8.request w = some r) (ex : r.extra = .binding a b) : w[0]? = some (20 : UInt8) := by
  cases h0 : w[0]? with
  | none => simp [Core8.request, h0] at rq
  | some t =>
    by_cases t0 : t = 0
    · subst t0; simp [Core8.request, h0] at rq; subst rq; cases ex
    by_cases t19 : t = 19
    · subst t19
      simp [Core8.request, h0] at rq
      by_cases hs : 3310 ≤ w.size
      · simp [hs, guard] at rq; subst rq; cases ex
      · simp [hs, guard, failure] at rq
    by_cases t20 : t = 20
    · subst t20; rfl
    · simp [Core8.request, h0, t0, t19, t20] at rq

/-- The decoder's `.ordinary` command with a single-signature extra comes only from tag 13 hex,
    whose Wire5 frame starts at byte 3310. -/
theorem ordinary_signed {w : ByteArray} {x : Wire5.Frame} {pq : Bytes}
    (dec : Policy9.decode w = some (.ordinary x (.signed pq))) :
    w[0]? = some (19 : UInt8) ∧ Wire5.decode (w.extract (1 + 3309) w.size) = some x := by
  unfold Policy9.decode at dec
  obtain ⟨tag, hdr, run⟩ := Option.bind_eq_some.mp dec
  split at run
  · obtain ⟨⟨y, r⟩, h, after⟩ := Option.bind_eq_some.mp run
    cases r <;> cases after
    unfold Policy9.issueFields at h
    simp only [bind, StateT.bind, pure, StateT.pure, Option.pure_def, Option.bind_eq_some] at h
    grind
  · obtain ⟨⟨y, r⟩, h, after⟩ := Option.bind_eq_some.mp run
    cases r <;> cases after
    unfold Policy9.cancelFields at h
    simp only [bind, StateT.bind, pure, StateT.pure, Option.pure_def, Option.bind_eq_some] at h
    grind
  · obtain ⟨y, _, after⟩ := Option.bind_eq_some.mp run
    split at after <;> cases after
  · obtain ⟨y, _, after⟩ := Option.bind_eq_some.mp run
    split at after <;> cases after
  · simp [pure] at run
  · simp [pure] at run
  · obtain ⟨r, rq, after⟩ := Option.bind_eq_some.mp run
    obtain ⟨y, dy, after⟩ := Option.bind_eq_some.mp after
    have shape : r.extra = .signed pq ∧ y = x := by
      split at after
      all_goals first
        | (simp only [pure, Option.some.injEq, Policy9.Command.ordinary.injEq] at after; exact ⟨after.2, after.1⟩)
        | (simp [pure] at after; done)
        | (split at after <;> simp [pure] at after)
    obtain ⟨ex, rfl⟩ := shape
    have t19 := request_signed rq ex
    rw [← request_signed_wire rq t19]
    exact ⟨t19, dy⟩

/-- Step 3: a frame the decoder reads as a plain approval is filed as `approval`. -/
theorem approval_is_filed {w : ByteArray} {x : Wire5.Frame} {pq : Bytes} {i : Intent} {sig : Bytes}
    (dec : Policy9.decode w = some (.ordinary x (.signed pq))) (act : x.action = .grant i sig) :
    formOf w = some .approval := by
  obtain ⟨tag, dx⟩ := ordinary_signed dec
  have parsed : Wire5.frameField (w.extract 3310 w.size).data.toList = some (x, []) := by
    unfold Wire5.decode at dx
    split at dx
    · rename_i y h; cases dx; exact h
    · cases dx
  have b40 := frame_grant parsed act
  rw [RecordBinding.extract_list] at b40
  have at3350 : w[3350]? = some (3 : UInt8) := by
    rw [RecordBinding.get_list]
    rw [List.getElem?_take, List.getElem?_drop] at b40
    split at b40
    · simpa using b40
    · cases b40
  exact formOf_approval tag at3350

/-- Step 3: a frame the decoder reads as an old key change is filed as `legacyKeyChange`. -/
theorem legacy_key_change_is_filed {w : ByteArray} {p : Digest} {n : Nat} {keys : Hybrid7.Keys} {ed ml : Bytes}
    (dec : Policy9.decode w = some (.rebind p n keys ed ml)) : formOf w = some .legacyKeyChange := by
  unfold Policy9.decode at dec
  obtain ⟨tag, hdr, run⟩ := Option.bind_eq_some.mp dec
  split at run
  · obtain ⟨⟨y, r⟩, h, after⟩ := Option.bind_eq_some.mp run
    cases r <;> cases after
    unfold Policy9.issueFields at h
    simp only [bind, StateT.bind, pure, StateT.pure, Option.pure_def, Option.bind_eq_some] at h
    grind
  · obtain ⟨⟨y, r⟩, h, after⟩ := Option.bind_eq_some.mp run
    cases r <;> cases after
    unfold Policy9.cancelFields at h
    simp only [bind, StateT.bind, pure, StateT.pure, Option.pure_def, Option.bind_eq_some] at h
    grind
  · obtain ⟨y, _, after⟩ := Option.bind_eq_some.mp run
    split at after <;> cases after
  · obtain ⟨y, _, after⟩ := Option.bind_eq_some.mp run
    split at after <;> cases after
  · simp [pure] at run
  · simp [pure] at run
  · obtain ⟨r, rq, after⟩ := Option.bind_eq_some.mp run
    obtain ⟨y, dy, after⟩ := Option.bind_eq_some.mp after
    have binding : ∃ a b, r.extra = .binding a b := by
      split at after
      all_goals first
        | (simp [pure] at after; done)
        | (split at after
           all_goals first
             | (simp [pure] at after; done)
             | exact ⟨_, _, by assumption⟩)
    obtain ⟨a, b, ex⟩ := binding
    have t20 := request_binding rq ex
    exact formOf_legacyKeyChange t20

#print axioms approval_is_filed
#print axioms legacy_key_change_is_filed
end Aukora.Forms
