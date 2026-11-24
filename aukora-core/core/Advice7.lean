import core.Upgrade6

namespace Advice7
open Aukora
open private Upgrade6.isOldUpgrade Upgrade6.applyUpgrade from core.Upgrade6
open private Bound4.remaining from core.Bound4

abbrev AuthorityView := Bytes × Nat × Digest × List Intent × List Intent

def authority (s : Bound5.Machine) : AuthorityView :=
  let a := s.inner.ledger.book.auth
  (s.ownerKey, a.generation, a.core, a.grants, a.admitted)

-- Controls sign the parent. Each copy must have the same signature verdict on its own header.
inductive OrdinaryPeer (x y : Wire5.Frame) (ka kb : Bytes) (ga gb : Nat) : Prop where
  | equal (h : x.action = y.action) (noControl : ∀ op sig, x.action ≠ .control op sig)
  | score (cell : String) (a b : Nat)
      (left : x.action = .plain (.base (.advise cell a)))
      (right : y.action = .plain (.base (.advise cell b)))
  | control (op : Wire5.Control) (a b : Bytes) (left : x.action = .control op a)
      (right : y.action = .control op b)
      (signed : Ed25519.verify ka (Wire5.controlBytes ga x op) a =
                Ed25519.verify kb (Wire5.controlBytes gb y op) b)

inductive LocalPair (hx hy : Digest) (nx ny : Nat) (a b : AuthorityView) (wx wy : ByteArray) : Prop where
  | ordinary (x y : Wire5.Frame) (dx : Upgrade6.decode wx = some (.ordinary x))
      (dy : Upgrade6.decode wy = some (.ordinary y))
      (px : x.parent = hx) (py : y.parent = hy) (sx : x.seq = nx+1) (sy : y.seq = ny+1)
      (op : OrdinaryPeer x y a.1 b.1 a.2.1 b.2.1)
  | certified (x y : Upgrade6.Upgrade) (dx : Upgrade6.decode wx = some (.certified x))
      (dy : Upgrade6.decode wy = some (.certified y))
      (px : x.parent = hx) (py : y.parent = hy) (sx : x.seq = nx+1) (sy : y.seq = ny+1)
      (target : x.target = y.target) (intent : x.intent = y.intent) (proof : x.proof = y.proof)

def advanceCmd {S} (step : ByteArray → S → Option S) (stage : Option ByteArray → S → S)
    (s : S) : Stateful5.Command → S
  | .reset => stage none s
  | .feed b => stage (some b) s
  | .submit w => (step w s).getD s

def walk {S} (step : ByteArray → S → Option S) (stage : Option ByteArray → S → S)
    (s : S) (cs : List Stateful5.Command) := cs.foldl (advanceCmd step stage) s

inductive Aligned {S} (step : ByteArray → S → Option S) (head : S → Digest) (seq : S → Nat)
    (auth : S → AuthorityView) (stage : Option ByteArray → S → S) :
    S → S → List Stateful5.Command → List Stateful5.Command → Prop where
  | nil {s t} : Aligned step head seq auth stage s t [] []
  | submit {s t wx wy xs ys} (op : LocalPair (head s) (head t) (seq s) (seq t) (auth s) (auth t) wx wy)
      (tail : Aligned step head seq auth stage ((step wx s).getD s) ((step wy t).getD t) xs ys) :
      Aligned step head seq auth stage s t (.submit wx :: xs) (.submit wy :: ys)
  | feed {s t b xs ys} (tail : Aligned step head seq auth stage (stage (some b) s) (stage (some b) t) xs ys) :
      Aligned step head seq auth stage s t (.feed b :: xs) (.feed b :: ys)
  | reset {s t xs ys} (tail : Aligned step head seq auth stage (stage none s) (stage none t) xs ys) :
      Aligned step head seq auth stage s t (.reset :: xs) (.reset :: ys)

def AdviceLaw {S} (step : ByteArray → S → Option S) (head : S → Digest) (seq : S → Nat)
    (auth : S → AuthorityView) (stage : Option ByteArray → S → S) : Prop :=
  ∀ s xs ys, Aligned step head seq auth stage s s xs ys →
    auth (walk step stage s xs) = auth (walk step stage s ys)

private def erase : R2.Action → R2.Action
  | .base (.advise cell _) => .base (.advise cell 0)
  | op => op

private abbrev H (a b : List R2.Frame) :=
  a.map (fun x => erase x.action) = b.map (fun x => erase x.action)

private theorem mapRead {α} {a b : List R2.Frame} (h : H a b) (f : R2.Action → α)
    (neutral : ∀ x, f (erase x) = f x) :
    a.map (fun x => f x.action) = b.map (fun x => f x.action) := by
  have eq := congrArg (List.map f) h
  simpa only [List.map_map, Function.comp_def, neutral] using eq

private theorem lookupRead {α} {a b : List R2.Frame} (h : H a b) (f : R2.Action → Option α)
    (neutral : ∀ x, f (erase x) = f x) (id : Nat) :
    R2.lookup f a id = R2.lookup f b id := by
  have eq := congrArg (fun (l : List (Option α)) => (l[id]?).join) (mapRead h f neutral)
  simpa [R2.lookup, List.getElem?_map, Option.join, Option.bind_map] using eq

private theorem anyRead {a b : List R2.Frame} (h : H a b) (f : R2.Action → Bool)
    (neutral : ∀ x, f (erase x) = f x) :
    a.any (fun x => f x.action) = b.any (fun x => f x.action) := by
  have eq := congrArg (fun (l : List Bool) => l.any id) (mapRead h f neutral)
  simpa [List.any_map, Function.comp_def] using eq

private structure LedgerEq (s t : R2.Ledger) : Prop where
  book : s.book = t.book
  active : s.active = t.active
  hist : H s.history t.history

private structure InnerEq (s t : Bound4.Machine) : Prop where
  led : LedgerEq s.ledger t.ledger
  stage : s.candidate = t.candidate

private structure StateEq (s t : Bound5.Machine) : Prop where
  inner : InnerEq s.inner t.inner
  key : s.ownerKey = t.ownerKey

private theorem view_eq {s t} (h : StateEq s t) : authority s = authority t := by
  simp [authority, h.inner.led.book, h.key]

private theorem history_read {s t} (h : LedgerEq s t) (id : Nat) :
    R2.mandateAt s.history id = R2.mandateAt t.history id ∧
    R2.budgetAt s.history id = R2.budgetAt t.history id ∧
    R2.passAt s.history id = R2.passAt t.history id ∧
    R2.revoked s.history id = R2.revoked t.history id := by
  refine ⟨lookupRead h.hist _ ?_ _, lookupRead h.hist _ ?_ _, lookupRead h.hist _ ?_ _, anyRead h.hist (fun a => match a with | .revoke k true => k == id | _ => false) ?_⟩ <;>
    intro x <;> cases x <;> try rfl
  all_goals rename_i e; cases e <;> rfl

private theorem policy_eq {s t} (h : LedgerEq s t) (op : R2.Action) :
    R2.policy s op = R2.policy t op := by
  have scope (m e) : R2.inScope s m e = R2.inScope t m e := by cases e <;> simp [R2.inScope, h.book]
  cases op <;> simp only [R2.policy, h.book, h.active, scope,
    (history_read h _).1, (history_read h _).2.1, (history_read h _).2.2.1, (history_read h _).2.2.2]

private theorem limit_eq {s t} (h : LedgerEq s t) (op : R2.Action) :
    R2.withinLimit s.history op = R2.withinLimit t.history op := by
  have total (m id) : R2.total s.history m id = R2.total t.history m id := by
    apply congrArg List.sum (mapRead h.hist (R2.quantity m id) ?_)
    intro x
    cases x <;> try rfl
    rename_i e; cases e <;> rfl
  have limit (m id) : R2.limit s.history m id = R2.limit t.history m id := by
    cases m <;> simp only [R2.limit, (history_read h _).1, (history_read h _).2.1]
  unfold R2.withinLimit
  split <;> simp only [total, limit]

private theorem used_eq {s t} (h : StateEq s t) (i : Intent) :
    Bound5.usedNonce s i = Bound5.usedNonce t i := by
  apply anyRead h.inner.led.hist (fun a => match a with
    | .base (.grant j true) => i.generation == j.generation && i.nonce == j.nonce | _ => false)
  intro x; cases x <;> try rfl
  rename_i e; cases e <;> rfl

private inductive Similar : R2.Action → R2.Action → Prop where
  | same (a) : Similar a a
  | advice (c a b) : Similar (.base (.advise c a)) (.base (.advise c b))

private theorem similar_consume {a b} (op : Similar a b) (f : R2.Action → α)
    (same : ∀ c x y, f (.base (.advise c x)) = f (.base (.advise c y))) :
    f a = f b := by cases op with
                     | same => rfl
                     | advice => apply same

private inductive Pair {α β} (r : α → β → Prop) : Option α → Option β → Prop where
  | none : Pair r none none
  | some {a b} : r a b → Pair r (some a) (some b)

private theorem pairMap {α β γ δ} {r : α → β → Prop} {p : γ → δ → Prop} {a b} (h : Pair r a b)
    (f : α → γ) (g : β → δ) (preserves : ∀ x y, r x y → p (f x) (g y)) :
    Pair p (a.map f) (b.map g) := by
  cases h with
  | none => exact .none
  | some eq => exact .some (preserves _ _ eq)

private theorem pairGet {α} {r : α → α → Prop} {a b} (h : Pair r a b) {s t} (start : r s t) :
    r (a.getD s) (b.getD t) := by cases h <;> assumption

private theorem ledger_pair {s t x y} (h : LedgerEq s t) (d e : R2.Frame → Digest)
    (px : x.parent = s.head) (py : y.parent = t.head) (sx : x.seq = s.book.seq+1)
    (sy : y.seq = t.book.seq+1) (op : Similar x.action y.action) :
    Pair LedgerEq (R2.next d s x) (R2.next e t y) := by
  have eligible : R2.Allowed s x ↔ R2.Allowed t y := by
    simp only [R2.Allowed, px, py, sx, sy, true_and]
    have pol := similar_consume op (R2.policy t) (by intros; rfl)
    have lim := similar_consume op (R2.withinLimit t.history) (by intros; rfl)
    rw [policy_eq h, limit_eq h, pol, lim]
  by_cases accepted : R2.Allowed s x
  · rw [R2.next, if_pos accepted, R2.next, if_pos (eligible.mp accepted)]
    apply Pair.some
    have len := congrArg List.length h.hist
    simp only [List.length_map] at len
    constructor
    · change R2.nextBook s.book x.action = R2.nextBook t.book y.action
      rw [h.book]; exact similar_consume op _ (by intros; rfl)
    · change R2.nextView s x.action = R2.nextView t y.action
      have eqv (a : R2.Action) : R2.nextView s a = R2.nextView t a := by
        cases a with
        | base e => cases e <;> simp [R2.nextView, h.active, len]
        | _ => simp [R2.nextView, h.active]
      exact (eqv x.action).trans (similar_consume op _ (by intros; rfl))
    · change H (s.history ++ [x]) (t.history ++ [y])
      simp only [H, List.map_append, List.map_cons, List.map_nil, h.hist]
      have same : erase x.action = erase y.action := similar_consume op _ (by intros; rfl)
      rw [same]
  · rw [R2.next, if_neg accepted, R2.next, if_neg (fun hit => accepted (eligible.mpr hit))]
    exact .none

private theorem inner_pair {s t x y} (h : InnerEq s t) (d e : R2.Frame → Digest)
    (px : x.parent = s.ledger.head) (py : y.parent = t.ledger.head) (sx : x.seq = s.ledger.book.seq+1)
    (sy : y.seq = t.ledger.book.seq+1) (op : Similar x.action y.action) :
    Pair InnerEq (Bound4.next d s x) (Bound4.next e t y) := by
  have stage : Bound4.candidateOK s.candidate x.action = Bound4.candidateOK t.candidate y.action := by
    rw [h.stage]; exact similar_consume op _ (by intros; rfl)
  have rest : Bound4.remaining s.candidate x.action = Bound4.remaining t.candidate y.action := by
    rw [h.stage]; exact similar_consume op _ (by intros; rfl)
  unfold Bound4.next
  rw [stage]
  split
  · exact pairMap (ledger_pair h.led d e px py sx sy op) _ _ (fun _ _ same => ⟨same, rest⟩)
  · exact .none

private theorem ordinary_pair {s t : Bound5.Machine} {x y} (h : StateEq s t)
    (px : x.parent = s.inner.ledger.head) (py : y.parent = t.inner.ledger.head)
    (sx : x.seq = s.inner.ledger.book.seq+1) (sy : y.seq = t.inner.ledger.book.seq+1)
    (op : OrdinaryPeer x y s.ownerKey t.ownerKey s.inner.ledger.book.auth.generation t.inner.ledger.book.auth.generation) :
    Pair StateEq (if Upgrade6.isOldUpgrade x.action then none else Bound5.next Ed25519.verify s x)
      (if Upgrade6.isOldUpgrade y.action then none else Bound5.next Ed25519.verify t y) := by
  have old : Upgrade6.isOldUpgrade x.action = Upgrade6.isOldUpgrade y.action := by cases op <;> simp_all [Upgrade6.isOldUpgrade]
  have proj : Similar x.project.action y.project.action := by
    cases op with
    | equal act _ => simp only [Wire5.Frame.project, act]; exact .same _
    | score c a b l r => simp only [Wire5.Frame.project, l, r, Wire5.Action.project]; exact .advice _ _ _
    | control o a b l r _ => simp only [Wire5.Frame.project, l, r, Wire5.Action.project]; exact .same _
  have after : Bound5.afterKey s x.action = Bound5.afterKey t y.action := by
    cases op with
    | equal he _ => rw [he]; cases y.action <;> simp [Bound5.afterKey, h.key]
    | score c a b l r => simpa [l, r, Bound5.afterKey] using h.key
    | control o a b l r _ => simpa [l, r, Bound5.afterKey] using h.key
  have auth : Bound5.authorized Ed25519.verify s x = Bound5.authorized Ed25519.verify t y := by
    cases op with
    | equal eq nc =>
      cases a : x.action with
      | control o sig => exact False.elim (nc _ _ a)
      | _ => simp [Bound5.authorized, ← eq, a, h.key, h.inner.led.book, used_eq h]
    | score c a b l r => simp [Bound5.authorized, l, r, Wire5.plainOK]
    | control o a b l r sig => simpa [Bound5.authorized, l, r] using sig
  rw [old]
  split
  · exact .none
  · unfold Bound5.next
    rw [auth]
    split
    · exact pairMap (inner_pair (x := x.project) (y := y.project) h.inner
          (fun _ => Bound5.frameDigest x) (fun _ => Bound5.frameDigest y) px py sx sy proj)
          _ _ (fun _ _ same => ⟨same, after⟩)
    · exact .none

private theorem one (ctx : R6.KernelCell.Context) {s t} (h : StateEq s t) {wx wy}
    (inputs : LocalPair s.inner.ledger.head t.inner.ledger.head s.inner.ledger.book.seq t.inner.ledger.book.seq
      (authority s) (authority t) wx wy) :
    StateEq ((Upgrade6.step ctx wx s).getD s) ((Upgrade6.step ctx wy t).getD t) := by
  have paired : Pair StateEq (Upgrade6.step ctx wx s) (Upgrade6.step ctx wy t) := by
    cases inputs with
    | ordinary x y dx dy px py sx sy op =>
      simp only [Upgrade6.step, dx, dy]
      exact ordinary_pair h px py sx sy op
    | certified x y dx dy px py sx sy target intent proof =>
      simp only [Upgrade6.step, dx, dy, Upgrade6.applyUpgrade]
      rw [target]
      split
      · have proj : Similar (x.frame ctx).action (y.frame ctx).action := by
          simp only [Upgrade6.Upgrade.frame, target, intent, proof]
          exact .same _
        exact pairMap (inner_pair (x := x.frame ctx) (y := y.frame ctx) h.inner
            (fun _ => Bound4.digest wx) (fun _ => Bound4.digest wy) px py sx sy proj)
            _ _ (fun _ _ same => ⟨same, h.key⟩)
      · exact .none
  exact pairGet paired h

def staging (b : Option ByteArray) (s : Bound5.Machine) :=
  match b with
  | none => Bound5.reset s
  | some bytes => Bound5.feed bytes s

private theorem stage_eq {s t} (h : StateEq s t) (b) : StateEq (staging b s) (staging b t) := by
  cases b with
  | none => exact ⟨⟨h.inner.led, rfl⟩, h.key⟩
  | some bytes => exact ⟨⟨h.inner.led, congrArg (· ++ bytes) h.inner.stage⟩, h.key⟩

theorem r6 (ctx : R6.KernelCell.Context) : AdviceLaw (Upgrade6.step ctx)
    (fun s => s.inner.ledger.head) (fun s => s.inner.ledger.book.seq) authority staging := by
  have walkEq {s t : Bound5.Machine} {xs ys : List Stateful5.Command}
      (a : Aligned (Upgrade6.step ctx) (fun s => s.inner.ledger.head)
        (fun s => s.inner.ledger.book.seq) authority staging s t xs ys) (h : StateEq s t) :
      StateEq (walk (Upgrade6.step ctx) staging s xs) (walk (Upgrade6.step ctx) staging t ys) := by
    induction a with
    | nil => exact h
    | submit op _ ih => exact ih (one ctx h op)
    | feed _ ih => exact ih (stage_eq h _)
    | reset _ ih => exact ih (stage_eq h _)
  intro s xs ys a
  exact view_eq (walkEq a ⟨⟨⟨rfl, rfl, rfl⟩, rfl⟩, rfl⟩)

#print axioms r6
end Advice7
