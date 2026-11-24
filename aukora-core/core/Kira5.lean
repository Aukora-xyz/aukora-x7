import core.Stateful5

namespace Aukora.Kira5
open R2

/-- The source occurs in the prefix strictly before the accepted remember frame.
    Both the stored claim and the source sequence are identified exactly. -/
def Origin (history : List R2.Frame) (c : Claim) : Prop :=
  ∃ before remember after source, history = before ++ remember :: after ∧
    source ∈ before ∧ source.seq = c.source ∧ source.seq < remember.seq ∧
    remember.action = .base (.remember c.id c.source c.text)

private theorem origin_extend {history c} (h : Origin history c) (x : R2.Frame) :
    Origin (history ++ [x]) c := by
  obtain ⟨before, remember, after, source, eqn, facts⟩ := h
  exact ⟨before, remember, after ++ [x], source, by simp [eqn, List.append_assoc], facts⟩

private def newClaims : R2.Action → List Claim
  | .base (.remember id src text) => [⟨id, src, text⟩]
  | _ => []

private theorem book_claims (b : Book) (a : R2.Action) :
    (nextBook b a).claims = b.claims ++ newClaims a := by
  cases a with
  | base e => cases e <;> simp [nextBook, advance, newClaims]
  | useMandate id e => cases e <;> simp [nextBook, newClaims]
  | _ => simp [nextBook, newClaims]

private theorem origin_action {a c} (h : c ∈ newClaims a) :
    a = .base (.remember c.id c.source c.text) := by
  cases a with
  | base e =>
    cases e <;> simp [newClaims] at h
    case remember id source text => subst c; rfl
  | _ => simp [newClaims] at h

private theorem book_seq (b : Book) (a : R2.Action) :
    (nextBook b a).seq = b.seq + 1 := by
  cases a with
  | base e => rfl
  | useMandate id e => cases e <;> rfl
  | _ => rfl

private structure Valid (s : R2.Ledger) : Prop where
  numbered : ∀ n, 0 < n → n ≤ s.book.seq → ∃ x ∈ s.history, x.seq = n
  sourced : ∀ c ∈ s.book.claims, Origin s.history c

private theorem ledger_valid {d s x t} (ok : R2.next d s x = some t) (valid : Valid s) :
    Valid t := by
  obtain ⟨allowed, rfl⟩ := R2.next_spec ok
  have seq := allowed.2.1
  constructor
  · intro n pos bound
    change n ≤ (nextBook s.book x.action).seq at bound
    rw [book_seq] at bound
    change ∃ f ∈ s.history ++ [x], f.seq = n
    by_cases old : n ≤ s.book.seq
    · obtain ⟨f, hf, hn⟩ := valid.numbered n pos old
      exact ⟨f, List.mem_append_left _ hf, hn⟩
    · exact ⟨x, by simp, by omega⟩
  · intro c hc
    change c ∈ (nextBook s.book x.action).claims at hc
    rw [book_claims, List.mem_append] at hc
    rcases hc with old | fresh
    · exact origin_extend (valid.sourced _ old) x
    · have ev := origin_action fresh
      have eligible : Eligible s.book (.remember c.id c.source c.text) := by
        simpa [ev, policy] using allowed.2.2.1
      have bounds : 0 < c.source ∧ c.source ≤ s.book.seq := by
        have h := eligible.2
        simp [eventOK] at h
        exact h.1
      obtain ⟨source, mem, num⟩ := valid.numbered _ bounds.1 bounds.2
      exact ⟨s.history, x, [], source, rfl, mem, num, by omega, ev⟩

open Stateful5 (Command applyCommand stepBytes)
open Bound5 (Machine initial)

/-- Capture only frames from successful wire submissions, in ledger representation. -/
private def acceptedOne (s : Machine) : Command → List R2.Frame
  | .submit wire =>
    if (stepBytes wire s).isSome then (Wire5.decode wire).toList.map Wire5.Frame.project else []
  | _ => []

def acceptedFrames (s : Machine) : List Command → List R2.Frame
  | [] => []
  | cmd :: cs => acceptedOne s cmd ++ acceptedFrames (applyCommand s cmd) cs

private theorem command_cases (s : Machine) (cmd : Command) :
    (acceptedOne s cmd = [] ∧ (applyCommand s cmd).inner.ledger = s.inner.ledger) ∨
    ∃ x d, acceptedOne s cmd = [x] ∧
      R2.next d s.inner.ledger x = some (applyCommand s cmd).inner.ledger := by
  cases cmd with
  | feed | reset => exact Or.inl ⟨rfl, rfl⟩
  | submit wire =>
    cases ok : stepBytes wire s with
    | none => exact Or.inl ⟨by simp [acceptedOne, ok], by simp [applyCommand, ok]⟩
    | some t =>
      cases dec : Wire5.decode wire with
      | none => simp [Stateful5.step_malformed dec] at ok
      | some x =>
        exact Or.inr ⟨x.project, _, by simp [acceptedOne, ok, dec],
          by simpa [applyCommand, ok] using Stateful5.ledger_refinement dec ok⟩

private theorem history_step (s : Machine) (cmd : Command) :
    (applyCommand s cmd).inner.ledger.history = s.inner.ledger.history ++ acceptedOne s cmd := by
  rcases command_cases s cmd with ⟨empty, same⟩ | ⟨x, d, one, ok⟩
  · simp [empty, same]
  · rw [(R2.next_spec ok).2, one]; rfl

/-- In particular the genesis ledger's history is exactly the successfully accepted
    projections of the trace. This includes malformed wires, feed and reset. -/
theorem history_run (s : Machine) (commands : List Command) :
    (commands.foldl applyCommand s).inner.ledger.history =
      s.inner.ledger.history ++ acceptedFrames s commands := by
  induction commands generalizing s with
  | nil => simp [acceptedFrames]
  | cons c cs ih => simp [acceptedFrames, ih, history_step, List.append_assoc]
#print axioms history_run

private theorem claims_step (s : Machine) (cmd : Command) :
    ∃ extra, (applyCommand s cmd).inner.ledger.book.claims = s.inner.ledger.book.claims ++ extra := by
  rcases command_cases s cmd with ⟨_, same⟩ | ⟨x, d, _, ok⟩
  · exact ⟨[], by simp [same]⟩
  · exact ⟨newClaims x.action, by rw [(R2.next_spec ok).2]; exact book_claims _ _⟩

/-- L9: the complete old list remains a prefix across any sequence of commands. -/
theorem claims_only_grow (s : Machine) (commands : List Command) :
    ∃ extra, (commands.foldl applyCommand s).inner.ledger.book.claims =
      s.inner.ledger.book.claims ++ extra := by
  induction commands generalizing s with
  | nil => exact ⟨[], by simp⟩
  | cons c cs ih =>
    obtain ⟨new, step⟩ := claims_step s c
    obtain ⟨tail, run⟩ := ih (applyCommand s c)
    exact ⟨new ++ tail, by simpa [step, List.append_assoc] using run⟩
#print axioms claims_only_grow

/-- A correction preserves the entire claims list and appends its own record. -/
theorem correction_preserves {s wire x t old replacement reason}
    (decoded : Wire5.decode wire = some x) (ok : stepBytes wire s = some t)
    (event : x.project.action = .base (.correct old replacement reason)) :
    t.inner.ledger.book.claims = s.inner.ledger.book.claims ∧
    t.inner.ledger.book.corrections =
      s.inner.ledger.book.corrections ++ [⟨old, replacement, reason⟩] := by
  rw [(R2.next_spec (Stateful5.ledger_refinement decoded ok)).2]
  simp [R2.append, nextBook, advance, event]
#print axioms correction_preserves

private theorem valid_run (s : Machine) (commands : List Command) (v : Valid s.inner.ledger) :
    Valid (commands.foldl applyCommand s).inner.ledger := by
  induction commands generalizing s with
  | nil => exact v
  | cons c cs ih =>
    apply ih (applyCommand s c)
    rcases command_cases s c with ⟨_, same⟩ | ⟨x, d, _, ok⟩
    · rw [same]; exact v
    · exact ledger_valid ok v

/-- L9: for every stored claim there was an earlier accepted event with its
    exact source sequence, before the matching accepted remember event. -/
theorem source_is_earlier (key : Bytes) (commands : List Command) (c : Claim)
    (mem : c ∈ (commands.foldl applyCommand (initial key)).inner.ledger.book.claims) :
    Origin (acceptedFrames (initial key) commands) c := by
  have start : Valid (initial key).inner.ledger := by
    constructor
    · intro n pos bound; change n ≤ 0 at bound; omega
    · intro c hc; contradiction
  have witness := (valid_run _ commands start).sourced c mem
  rw [history_run] at witness
  exact witness
#print axioms source_is_earlier

/-- Historical confirmation for this intent, with unknown as the default. -/
def outcomeView (s : Machine) (i : Intent) : Result :=
  if s.inner.ledger.history.any (fun x => decide (x.action = .base (.outcome i .confirmed)))
    then .confirmed else .unknown

/-- L10: a confirmation exists in the accepted input iff the model view shows
    confirmed. Every other trace gives unknown, including failed outcomes alone. -/
theorem honest_outcome (key : Bytes) (commands : List Command) (i : Intent) :
    let final := commands.foldl applyCommand (initial key)
    let reported := ∃ x ∈ acceptedFrames (initial key) commands, x.action = .base (.outcome i .confirmed)
    (outcomeView final i = .confirmed ↔ reported) ∧ (outcomeView final i = .unknown ↔ ¬ reported) := by
  dsimp only
  unfold outcomeView
  rw [history_run]
  have start : (Bound5.initial key).inner.ledger.history = [] := rfl
  simp only [start, List.nil_append]
  split
  next h =>
    have report : ∃ x ∈ acceptedFrames (initial key) commands, x.action = .base (.outcome i .confirmed) := by
      simpa using h
    simp [report]
  next h =>
    have absent : ¬ ∃ x ∈ acceptedFrames (initial key) commands, x.action = .base (.outcome i .confirmed) := by
      simpa using h
    simp [absent]
#print axioms honest_outcome

end Aukora.Kira5
