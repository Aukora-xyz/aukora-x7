import core.Advice7
import core.Kira5

namespace Laws7
open Aukora
open R6.KernelCell (Context)
open Stateful5 (Command)

-- Public commands submit wire bytes, append a candidate chunk, or clear candidate staging.
-- The extra observations let a client audit sequence, provenance and the exact staged bytes.
structure Ops where
  State : Type
  step : ByteArray → State → Option State
  stage : Option ByteArray → State → State
  head : State → Digest
  seq : State → Nat
  core : State → Digest
  owner : State → Bytes
  generation : State → Nat
  grants : State → List Intent
  admitted : State → List Intent
  active : State → List Nat
  claims : State → List Claim
  outcomes : State → Intent → Result
  history : State → List R2.Frame
  candidate : State → ByteArray

structure Machine extends Ops where
  genesis : Bytes → State

def R6Machine (ctx : Context) : Machine where
  State := Bound5.Machine
  genesis := Bound5.initial
  step := Upgrade6.step ctx
  stage := fun chunk s => match chunk with
    | none => Bound5.reset s
    | some bytes => Bound5.feed bytes s
  head := fun s => s.inner.ledger.head
  seq := fun s => s.inner.ledger.book.seq
  core := fun s => s.inner.ledger.book.auth.core
  owner := Bound5.Machine.ownerKey
  generation := fun s => s.inner.ledger.book.auth.generation
  grants := fun s => s.inner.ledger.book.auth.grants
  admitted := fun s => s.inner.ledger.book.auth.admitted
  active := fun s => s.inner.ledger.active
  claims := fun s => s.inner.ledger.book.claims
  outcomes := Kira5.outcomeView
  history := fun s => s.inner.ledger.history
  candidate := fun s => s.inner.candidate

def applyCmd (m : Ops) (s : m.State) : Command → m.State
  | .reset => m.stage none s
  | .feed chunk => m.stage (some chunk) s
  | .submit w => (m.step w s).getD s

def run (m : Ops) (s : m.State) (cs : List Command) := cs.foldl (applyCmd m) s

def keep (m : Ops) (s : m.State) : Command → Bool
  | .submit w => (m.step w s).isSome
  | _ => true

def kept (m : Ops) (s : m.State) : List Command → List Command
  | [] => []
  | c :: cs => if keep m s c then c :: kept m (applyCmd m s c) cs else kept m (applyCmd m s c) cs

-- The log records the public event, not the signature or proof blob. Replay uses the original bytes.
def frame (ctx : Context) (w : ByteArray) : Option R2.Frame :=
  match Upgrade6.decode w with
  | some (.ordinary x) => some x.project
  | some (.certified u) => some (u.frame ctx)
  | none => none

def entry (ctx : Context) : Command → Option R2.Frame
  | .submit w => frame ctx w
  | _ => none

def entries (ctx : Context) (m : Ops) (s : m.State) (cs : List Command) :=
  (kept m s cs).filterMap (entry ctx)

def auth (m : Ops) (s : m.State) := (m.owner s, m.generation s, m.core s, m.grants s, m.admitted s)

def Uses (ctx : Context) (w : ByteArray) (i : Intent) : Prop :=
  ∃ f e, frame ctx w = some f ∧ f.action = .base e ∧ spendIntent e = some i

-- Mathematical signature verification is unconditional. Key custody and unforgeability
-- enter only when the reader infers that the human actually signed a verified message.
def Signed (key message sig : Bytes) : Prop :=
  Ed25519.verify key message sig = true ∧
    ∀ (issued : Bytes → Bytes → Prop),
      (∀ k m signature, Ed25519.verify k m signature = true → issued k m) → issued key message

private theorem signed_of_verify {k m sig} (h : Ed25519.verify k m sig = true) : Signed k m sig :=
  ⟨h, fun _ sound => sound _ _ _ h⟩

def Issues (w : ByteArray) (i : Intent) : Prop :=
  ∃ x sig, Upgrade6.decode w = some (.ordinary x) ∧ x.action = .grant i sig

def NoIssue (m : Ops) (s : m.State) (cs : List Command) (i : Intent) : Prop :=
  ∀ w, Command.submit w ∈ kept m s cs → ¬ Issues w i

-- Each instantaneous clause applies at *every* state, in particular after any trace.
structure Laws (m : Ops) (start : m.State) (ctx : Context) : Prop where
  /-- L1. Two hosts replaying the same accepted bytes and staging commands recover the same state. -/
  replay : ∀ s cs, run m s (kept m s cs) = run m s cs
  /-- L2. Accepted events extend the record in order, and each active line names a recorded statement. -/
  record : (∀ s cs, m.history (run m s cs) = m.history s ++ entries ctx m s cs) ∧
    ∀ cs id, id ∈ m.active (run m start cs) → ∃ text, R2.lineAt (m.history (run m start cs)) id = some text
  /-- L3. A submission with a stale parent or incorrect sequence is refused. -/
  stale : ∀ s w f, frame ctx w = some f → (f.parent ≠ m.head s ∨ f.seq ≠ m.seq s + 1) →
    m.step w s = none ∧ applyCmd m s (.submit w) = s
  /-- L4. A grant needs the owner's signature, and a direct act or install spends it exactly once. -/
  once : (∀ s w t i, m.step w s = some t → i ∉ m.grants s → i ∈ m.grants t →
      ∃ x sig, Upgrade6.decode w = some (.ordinary x) ∧ x.action = .grant i sig ∧
        Signed (m.owner s) (Wire5.intentBytes i) sig) ∧
    ∀ s w t i, m.step w s = some t → Uses ctx w i →
      i ∈ m.grants s ∧ i.generation = m.generation s ∧ m.admitted t = i :: m.admitted s ∧ i ∉ m.grants t ∧
      ∀ cs, NoIssue m t cs i → ∀ later, Uses ctx later i → m.step later (run m t cs) = none
  /-- L5. A line, memory, correction, score or outcome leaves the owner's powers unchanged. -/
  passive : ∀ s w t f e, m.step w s = some t → frame ctx w = some f → f.action = .base e →
    Passive e → auth m t = auth m s
  /-- L6. Matching proposals addressed to each run's own head give advice scores no authority. -/
  advice : Advice7.AdviceLaw m.step m.head m.seq (auth m) m.stage
  /-- L7. Rebinding needs the old owner's signature, empties the grants and forever bars old-generation spends. -/
  restore : (∀ s w t, m.step w s = some t → m.owner t ≠ m.owner s →
      ∃ x sig, Upgrade6.decode w = some (.ordinary x) ∧ x.action = .rebind (m.owner t) sig ∧
        Signed (m.owner s) (Wire5.rebindBytes (m.generation s) (m.owner t)) sig) ∧
    ∀ s w t x key sig, m.step w s = some t → Upgrade6.decode w = some (.ordinary x) →
    x.action = .rebind key sig → Signed (m.owner s) (Wire5.rebindBytes (m.generation s) key) sig ∧
    m.owner t = key ∧ m.grants t = [] ∧ m.generation t = m.generation s + 1 ∧
    ∀ cs later i, i.generation ≤ m.generation s → Uses ctx later i → m.step later (run m t cs) = none
  /-- L8. A change of core spends an exact install grant for staged bytes and carries a proof the checker accepts. -/
  upgrade : ∀ s w t, m.step w s = some t → m.core t ≠ m.core s →
    ∃ u, Upgrade6.decode w = some (.certified u) ∧ R6.KernelCell.check ctx u.proof = true ∧
      u.target = m.core t ∧ m.core t = Bound4.digest (m.candidate s) ∧ u.intent.body = .install (m.core t) ∧
      u.intent ∈ m.grants s ∧ u.intent ∉ m.grants t ∧
      ∀ approved, u.intent.body = .install (Bound4.digest approved) →
        (Bound4.digest (m.candidate s) = Bound4.digest approved → m.candidate s = approved) →
        m.candidate s = approved
  /-- L9. Claims only grow, including across corrections, and every claim names an earlier accepted source. -/
  memory : (∀ s cs, ∃ suffix, m.claims (run m s cs) = m.claims s ++ suffix) ∧
    (∀ s w t f old replacement reason, m.step w s = some t → frame ctx w = some f →
      f.action = .base (.correct old replacement reason) → m.claims t = m.claims s) ∧
    ∀ cs c, c ∈ m.claims (run m start cs) → Kira5.Origin (entries ctx m start cs) c
  /-- L10. An intent shows confirmed exactly when an accepted event reported that confirmation, otherwise unknown. -/
  outcome : ∀ cs i,
    let final := run m start cs
    let reported := ∃ x ∈ entries ctx m start cs, x.action = .base (.outcome i .confirmed)
    (m.outcomes final i = .confirmed ↔ reported) ∧ (m.outcomes final i = .unknown ↔ ¬ reported)

def Lawful (model : Context → Machine) : Prop :=
  ∀ ctx key, Laws (model ctx).toOps ((model ctx).genesis key) ctx

theorem lawful_precompose {model : Context → Machine} (h : Lawful model) (f : Bytes → Bytes) :
    Lawful (fun ctx => {model ctx with genesis := fun key => (model ctx).genesis (f key)}) :=
  fun ctx key => h ctx (f key)

private abbrev ops (ctx : Context) := (R6Machine ctx).toOps

private theorem replay_law (m : Ops) (s : m.State) (cs : List Command) : run m s (kept m s cs) = run m s cs := by
  induction cs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c with
    | reset | feed => exact ih _
    | submit w =>
      cases h : m.step w s with
      | none => simpa [kept, keep, run, applyCmd, h] using ih s
      | some t => simpa [kept, keep, run, applyCmd, h] using ih t

open private Upgrade6.applyUpgrade from core.Upgrade6
open private Kira5.Valid Kira5.Valid.sourced Kira5.ledger_valid Kira5.book_claims Kira5.newClaims from core.Kira5

private theorem ordinary {ctx w s t x} (h : Upgrade6.decode w = some (.ordinary x))
    (ok : Upgrade6.step ctx w s = some t) : Bound5.next Ed25519.verify s x = some t := by
  simp only [Upgrade6.step, h] at ok
  split at ok <;> first | exact ok | contradiction

private theorem refinement {ctx w s t} (ok : Upgrade6.step ctx w s = some t) :
    ∃ f d, frame ctx w = some f ∧ R2.next d s.inner.ledger f = some t.inner.ledger := by
  cases h : Upgrade6.decode w with
  | none => simp [Upgrade6.step, h] at ok
  | some inp =>
    cases inp with
    | ordinary x =>
      exact ⟨x.project, _, by simp [frame, h], (Bound4.accepted (Bound5.accepted (ordinary h ok)).2.1).2⟩
    | certified u =>
      simp only [Upgrade6.step, h, Upgrade6.applyUpgrade] at ok
      split at ok
      next =>
        cases hb : Bound4.next (fun _ => Bound4.digest w) s.inner (u.frame ctx) with
        | none => simp [hb] at ok
        | some inner =>
          rw [hb] at ok
          change some (Bound5.Machine.mk inner s.ownerKey) = some t at ok
          cases Option.some.inj ok
          exact ⟨_, _, by simp [frame, h], (Bound4.accepted hb).2⟩
      next => contradiction

private theorem frame_refines {ctx w s t f} (ok : Upgrade6.step ctx w s = some t)
    (decoded : frame ctx w = some f) : ∃ d, R2.next d s.inner.ledger f = some t.inner.ledger := by
  obtain ⟨f', d, h, hn⟩ := refinement ok
  cases Option.some.inj (h.symm.trans decoded)
  exact ⟨d, hn⟩

private def one (ctx : Context) (s : Bound5.Machine) (c : Command) : List R2.Frame :=
  if keep (ops ctx) s c then (entry ctx c).toList else []

private theorem command_cases (ctx : Context) (s : Bound5.Machine) (c : Command) :
    (one ctx s c = [] ∧ (applyCmd (ops ctx) s c).inner.ledger = s.inner.ledger) ∨
    ∃ f d, one ctx s c = [f] ∧ R2.next d s.inner.ledger f = some (applyCmd (ops ctx) s c).inner.ledger := by
  cases c with
  | feed | reset => exact Or.inl ⟨rfl, rfl⟩
  | submit w =>
    cases ok : Upgrade6.step ctx w s with
    | none => exact Or.inl ⟨by simp [one, keep, ops, R6Machine, ok], by simp [applyCmd, ops, R6Machine, ok]⟩
    | some t =>
      obtain ⟨f, d, h, hn⟩ := refinement ok
      exact Or.inr ⟨f, d, by simp [one, keep, ops, R6Machine, entry, ok, h],
        by simpa [applyCmd, ops, R6Machine, ok] using hn⟩

private theorem entries_cons (ctx : Context) (s : Bound5.Machine) (c : Command) (cs : List Command) :
    entries ctx (ops ctx) s (c :: cs) = one ctx s c ++ entries ctx (ops ctx) (applyCmd (ops ctx) s c) cs := by
  by_cases hk : keep (ops ctx) s c = true
  · simp only [entries, kept, hk, if_true, List.filterMap_cons, one]
    cases entry ctx c <;> rfl
  · simp [entries, kept, hk, one]

private theorem history_trace (ctx : Context) (s : Bound5.Machine) (cs : List Command) :
    (run (ops ctx) s cs).inner.ledger.history = s.inner.ledger.history ++ entries ctx (ops ctx) s cs := by
  induction cs generalizing s with
  | nil => simp [run, entries, kept]
  | cons c cs ih =>
    change (run (ops ctx) (applyCmd (ops ctx) s c) cs).inner.ledger.history = _
    rw [ih, entries_cons, ← List.append_assoc]
    congr 1
    rcases command_cases ctx s c with ⟨empty, same⟩ | ⟨f, d, oneF, hn⟩
    · simp [empty, same]
    · rw [(R2.next_spec hn).2, oneF]; rfl

-- Transport an arbitrary ledger invariant along every input, including staging and refusal.
private theorem preserve (ctx : Context) (p : R2.Ledger → Prop)
    (closed : ∀ {d l f t}, R2.next d l f = some t → p l → p t)
    (s : Bound5.Machine) (cs : List Command) (hs : p s.inner.ledger) : p (run (ops ctx) s cs).inner.ledger := by
  induction cs generalizing s with
  | nil => exact hs
  | cons c cs ih =>
    apply ih (applyCmd (ops ctx) s c)
    rcases command_cases ctx s c with ⟨_, same⟩ | ⟨_, _, _, hn⟩
    · rw [same]; exact hs
    · exact closed hn hs

private theorem stale_law {ctx w f} {s : Bound5.Machine} (dec : frame ctx w = some f)
    (bad : f.parent ≠ s.inner.ledger.head ∨ f.seq ≠ s.inner.ledger.book.seq + 1) : Upgrade6.step ctx w s = none := by
  cases ok : Upgrade6.step ctx w s with
  | none => rfl
  | some t =>
    obtain ⟨_, hn⟩ := frame_refines ok dec
    have allowed := (R2.next_spec hn).1
    exact False.elim (bad.elim (fun h => h allowed.1) (fun h => h allowed.2.1))

private theorem new_grant {ctx w s t i} (ok : Upgrade6.step ctx w s = some t)
    (old : i ∉ s.inner.ledger.book.auth.grants) (added : i ∈ t.inner.ledger.book.auth.grants) :
    ∃ x sig, Upgrade6.decode w = some (.ordinary x) ∧ x.action = .grant i sig ∧
      Signed s.ownerKey (Wire5.intentBytes i) sig := by
  cases dec : Upgrade6.decode w with
  | none => simp [Upgrade6.step, dec] at ok
  | some input =>
    cases input with
    | ordinary x =>
      obtain ⟨sig, ev, signed⟩ := Bound5.new_grant_requires_signature (ordinary dec ok) old added
      exact ⟨x, sig, rfl, ev, signed_of_verify signed⟩
    | certified u =>
      obtain ⟨d, hn⟩ := frame_refines ok (f := u.frame ctx) (by simp [frame, dec])
      exact False.elim ((Events4.grant_absent_after hn old (by simp [Upgrade6.Upgrade.frame])) added)

private theorem spends {ctx w s t i} (ok : Upgrade6.step ctx w s = some t) (use : Uses ctx w i) :
    i ∈ s.inner.ledger.book.auth.grants ∧ i.generation = s.inner.ledger.book.auth.generation ∧
    t.inner.ledger.book.auth.admitted = i :: s.inner.ledger.book.auth.admitted ∧ i ∉ t.inner.ledger.book.auth.grants := by
  obtain ⟨f,e,dec,ev,sp⟩ := use
  obtain ⟨d, hn⟩ := frame_refines ok dec
  obtain ⟨allowed, ht⟩ := R2.next_spec hn
  have eligible : Eligible s.inner.ledger.book e := by simpa [ev, R2.policy] using allowed.2.2.1
  have gate : i ∈ s.inner.ledger.book.auth.grants ∧ i.generation = s.inner.ledger.book.auth.generation := by
    simpa [spendOK, sp] using eligible.1
  refine ⟨gate.1, gate.2, ?_⟩
  cases e <;> simp [spendIntent] at sp
  all_goals subst i; simp [ht, R2.append, R2.nextBook, advance, changeAuth, spend, ev, List.mem_filter]

private theorem absent {ctx i} (s : Bound5.Machine) (cs : List Command)
    (h : i ∉ s.inner.ledger.book.auth.grants) (noNew : NoIssue (ops ctx) s cs i) :
    i ∉ (run (ops ctx) s cs).inner.ledger.book.auth.grants := by
  induction cs generalizing s with
  | nil => exact h
  | cons c cs ih =>
    apply ih (applyCmd (ops ctx) s c)
    · cases c with
      | reset | feed => exact h
      | submit w =>
        cases ok : Upgrade6.step ctx w s with
        | none => simpa [applyCmd, ops, R6Machine, ok] using h
        | some t =>
          intro mem
          have added : i ∈ t.inner.ledger.book.auth.grants := by simpa [applyCmd, ops, R6Machine, ok] using mem
          obtain ⟨x, sig, dec, ev, _⟩ := new_grant ok h added
          exact noNew w (by simp [kept, keep, ops, R6Machine, ok]) ⟨x, sig, dec, ev⟩
    · intro w hw
      apply noNew w
      unfold kept
      split <;> simp_all

private theorem once_law {ctx w s t i} (ok : Upgrade6.step ctx w s = some t) (use : Uses ctx w i)
    (cs : List Command) (noNew : NoIssue (ops ctx) t cs i) {w'} (later : Uses ctx w' i) :
    Upgrade6.step ctx w' (run (ops ctx) t cs) = none := by
  have gone := absent t cs (spends ok use).2.2.2 noNew
  cases h : Upgrade6.step ctx w' (run (ops ctx) t cs) with
  | none => rfl
  | some _ => exact False.elim (gone (spends h later).1)

private theorem owner_change {ctx w s t} (ok : Upgrade6.step ctx w s = some t) (changed : t.ownerKey ≠ s.ownerKey) :
    ∃ x sig, Upgrade6.decode w = some (.ordinary x) ∧ x.action = .rebind t.ownerKey sig ∧
      Signed s.ownerKey (Wire5.rebindBytes s.inner.ledger.book.auth.generation t.ownerKey) sig := by
  cases decoded : Upgrade6.decode w with
  | none => simp [Upgrade6.step, decoded] at ok
  | some input =>
    cases input with
    | certified u => exact False.elim (changed (Upgrade6.upgrade_requires_proof decoded ok).owner)
    | ordinary x =>
      obtain ⟨sig, act, verified, _⟩ := Bound5.owner_change_only (ordinary decoded ok) changed
      exact ⟨x, sig, rfl, act, signed_of_verify verified⟩

private theorem passive_law {ctx w s t f e} (ok : Upgrade6.step ctx w s = some t) (dec : frame ctx w = some f)
    (ev : f.action = .base e) (p : Passive e) : auth (ops ctx) t = auth (ops ctx) s := by
  obtain ⟨d, hn⟩ := frame_refines ok dec
  have same : t.inner.ledger.book.auth = s.inner.ledger.book.auth := by
    rw [(R2.next_spec hn).2]
    change (R2.nextBook _ f.action).auth = _
    rw [ev]
    cases e <;> simp_all [Passive, R2.nextBook, advance, changeAuth]
  have key : t.ownerKey = s.ownerKey := by
    apply Classical.byContradiction
    intro h
    obtain ⟨x, sig, decoded, act, _⟩ := owner_change ok h
    have eq : x.project = f := by simpa [frame, decoded] using dec
    have reb : f.action = .base (.rebind (Wire5.keyName t.ownerKey) true) := by
      simp [← eq, Wire5.Frame.project, Wire5.Action.project, act]
    cases R2.Action.base.inj (ev.symm.trans reb)
    exact p
  change (t.ownerKey, t.inner.ledger.book.auth.generation, t.inner.ledger.book.auth.core,
    t.inner.ledger.book.auth.grants, t.inner.ledger.book.auth.admitted) = _
  rw [key, same]
  rfl

private theorem generation_grows {d l f t} (hn : R2.next d l f = some t) :
    l.book.auth.generation ≤ t.book.auth.generation := by
  rw [(R2.next_spec hn).2]
  change _ ≤ (R2.nextBook _ f.action).auth.generation
  cases f.action with
  | base e => cases e <;> simp [R2.nextBook, advance, changeAuth, spend]
  | useMandate id e => cases e <;> simp [R2.nextBook]
  | _ => simp [R2.nextBook]

private theorem obsolete {ctx s t w x key sig} (ok : Upgrade6.step ctx w s = some t)
    (dec : Upgrade6.decode w = some (.ordinary x)) (ev : x.action = .rebind key sig)
    (cs : List Command) {later i} (old : i.generation ≤ s.inner.ledger.book.auth.generation)
    (use : Uses ctx later i) : Upgrade6.step ctx later (run (ops ctx) t cs) = none := by
  have gen := (Bound5.rebind_verified (ordinary dec ok) ev).2.2.2
  have mono := preserve ctx (fun l => t.inner.ledger.book.auth.generation ≤ l.book.auth.generation)
    (fun hn h => Nat.le_trans h (generation_grows hn)) t cs (Nat.le_refl _)
  cases h : Upgrade6.step ctx later (run (ops ctx) t cs) with
  | none => rfl
  | some _ =>
    have eq := (spends h use).2.1
    dsimp only at mono
    omega

private theorem grow_claims (ctx : Context) (s : Bound5.Machine) (cs : List Command) :
    ∃ suffix, (run (ops ctx) s cs).inner.ledger.book.claims = s.inner.ledger.book.claims ++ suffix := by
  refine preserve ctx (fun l => ∃ extra, l.book.claims = s.inner.ledger.book.claims ++ extra) ?_ s cs ?_
  · intro d l f t hn prev
    obtain ⟨xs,h⟩ := prev
    refine ⟨xs ++ Kira5.newClaims f.action, ?_⟩
    rw [(R2.next_spec hn).2]
    change (R2.nextBook _ _).claims = _
    rw [Kira5.book_claims, h, List.append_assoc]
  · exact ⟨[], (List.append_nil _).symm⟩

private theorem source (ctx : Context) (key : Bytes) (cs : List Command) (c : Claim)
    (hc : c ∈ (run (ops ctx) (Bound5.initial key) cs).inner.ledger.book.claims) :
    Kira5.Origin (entries ctx (ops ctx) (Bound5.initial key) cs) c := by
  have init : Kira5.Valid (Bound5.initial key).inner.ledger := by
    constructor
    · intro n pos bound; change n ≤ 0 at bound; omega
    · intro c hc; contradiction
  have result := Kira5.Valid.sourced (preserve ctx Kira5.Valid Kira5.ledger_valid _ cs init) c hc
  rw [history_trace] at result
  exact result

private theorem view (ctx : Context) (key : Bytes) (cs : List Command) :
    R2.ViewSound (run (ops ctx) (Bound5.initial key) cs).inner.ledger := by
  refine preserve ctx R2.ViewSound ?_ _ cs ?_
  · intro d l f t hn valid
    have h := R2.view_step d l f valid
    simpa [R2.step, hn] using h
  · intro id mem; contradiction

private theorem outcomes (ctx : Context) (key : Bytes) (cs : List Command) (i : Intent) :
    let s := run (ops ctx) (Bound5.initial key) cs
    let reported := ∃ x ∈ entries ctx (ops ctx) (Bound5.initial key) cs, x.action = .base (.outcome i .confirmed)
    (Kira5.outcomeView s i = .confirmed ↔ reported) ∧ (Kira5.outcomeView s i = .unknown ↔ ¬ reported) := by
  dsimp only
  unfold Kira5.outcomeView
  rw [history_trace]
  have zero : (Bound5.initial key).inner.ledger.history = [] := rfl
  simp only [zero, List.nil_append]
  split
  next h =>
    have present : ∃ x ∈ entries ctx (ops ctx) (Bound5.initial key) cs, x.action = .base (.outcome i .confirmed) := by
      simpa using h
    simp [present]
  next h =>
    have missing : ¬ ∃ x ∈ entries ctx (ops ctx) (Bound5.initial key) cs, x.action = .base (.outcome i .confirmed) := by
      simpa using h
    simp [missing]

theorem r6_lawful : Lawful R6Machine := by
  intro ctx key
  constructor
  · exact replay_law _
  · exact ⟨history_trace ctx, view ctx key⟩
  · intro s w f dec bad
    have h := stale_law dec bad
    refine ⟨h, ?_⟩
    change (Upgrade6.step ctx w s).getD s = s
    rw [h]; rfl
  · refine ⟨fun _ _ _ _ ok old added => new_grant ok old added, ?_⟩
    intro s w t i ok use
    obtain ⟨granted, gen, admitted, spent⟩ := spends ok use
    exact ⟨granted, gen, admitted, spent, fun cs noNew _ later => once_law ok use cs noNew later⟩
  · exact fun _ _ _ _ _ ok dec ev p => passive_law ok dec ev p
  · exact Advice7.r6 ctx
  · refine ⟨fun _ _ _ ok changed => owner_change ok changed, ?_⟩
    intro s w t x key' sig ok dec ev
    obtain ⟨signed, owner, empty, gen⟩ := Bound5.rebind_verified (ordinary dec ok) ev
    exact ⟨signed_of_verify signed, owner, empty, gen, fun cs _ _ old use => obsolete ok dec ev cs old use⟩
  · intro s w t ok changed
    obtain ⟨u, dec, a⟩ := Upgrade6.core_change_requires_proof ok changed
    refine ⟨u, dec, a.checked, a.staged.symm.trans a.installed.symm, a.installed,
      a.intent.trans (congrArg Body.install a.installed.symm), a.granted, a.spent, ?_⟩
    exact fun approved body safe => safe (Body.install.inj (a.intent.symm.trans body))
  · refine ⟨grow_claims ctx, ?_, source ctx key⟩
    intro s w t f old replacement reason ok dec act
    obtain ⟨d, hn⟩ := frame_refines ok dec
    change t.inner.ledger.book.claims = s.inner.ledger.book.claims
    rw [(R2.next_spec hn).2]
    simp [R2.append, R2.nextBook, advance, act]
  · exact outcomes ctx key

-- Both traces have an empty event log, but discarding a staging command loses the uploaded byte.
theorem staging_counterexample (ctx : Context) (key : Bytes) :
    run (ops ctx) (Bound5.initial key) [.feed ⟨#[7]⟩] ≠ run (ops ctx) (Bound5.initial key) [] := by
  intro same
  have sizes := congrArg (fun s : Bound5.Machine => s.inner.candidate.size) same
  exact Nat.noConfusion (show (1 : Nat) = 0 from sizes)

#print axioms staging_counterexample
#print axioms r6_lawful
#print axioms lawful_precompose

end Laws7
