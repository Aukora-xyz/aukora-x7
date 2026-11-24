import ReleaseInterface
import Proofs.Origin
import Proofs.Stamp
import Proofs.DangerWire

namespace Aukora.Release
open R6.KernelCell (Context)
open private Core8.header Core8.metadata Core8.assessment Core8.thresholdControl Core8.append from Ledger.Assessed
open private RiskWire8.act_ok from Proofs.DangerWire
open private Policy9.applyBase Policy9.setPool Policy9.append from Policy
open private Policy9.bound Policy9.parsed Policy9.ran from Proofs.Policy
open private Upgrade9.install_ok from Gate
open private Kira5.Valid Kira5.Valid.sourced Kira5.Valid.numbered Kira5.ledger_valid Kira5.newClaims Kira5.book_claims from Proofs.Origin

/-- Decode the ledger entry from the wire alone. The raw signed bytes remain in the public record. -/
def entryFor (wire : ByteArray) : Policy9.Command → Option R2.Frame
  | .ordinary x _ => some x.project
  | .assessment => do
    let (p,n) ← Core8.header wire
    let v ← wire[73]?
    return ⟨p,n,.base (.advise "AUKORA/R8/assess" v.toNat)⟩
  | .threshold => do
    let (p,n) ← Core8.header wire
    let v ← wire[41]?
    return ⟨p,n,.base (.advise "AUKORA/R8/threshold" v.toNat)⟩
  | .use _ => (Wire5.decode (wire.extract 33 wire.size)).map Wire5.Frame.project
  | .issue p n _ i _ _ => some ⟨p,n,.base (.grant i true)⟩
  | .cancel p n _ _ _ => some ⟨p,n,.base (.advise "AUKORA/R9/revoke" 0)⟩
  | .report p n i v _ => some ⟨p,n,.base (.outcome i v)⟩
  | .rebind p n k ed _ => some (Wire5.Frame.project ⟨p,n,.rebind k.ed ed⟩)

def projected (w : ByteArray) : Option R2.Frame :=
  if w[0]? = some (27 : UInt8) then (Upgrade9.decode w).map Upgrade9.frame
  else (Policy9.decode w).bind (entryFor w)

private abbrev replacePool (l : R2.Ledger) (g : List Intent) := {l with book.auth.grants := g}

private def Refines (wire : ByteArray) (f : R2.Frame) (s t : Core8.Machine) : Prop :=
  ∃ grants, R2.next (fun _ => Bound4.digest wire) (replacePool s.hybrid.inner.ledger grants) f =
    some t.hybrid.inner.ledger

private theorem appended {s w f t} (ok : Policy9.append s w f = some t) : Refines w f s t := by
  obtain ⟨inner, accepted, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  exact ⟨_, (Bound4.accepted accepted).2⟩

private theorem filtered {s w f t g} (ok : Policy9.append (Policy9.setPool s g) w f = some t) :
    Refines w f s t := by
  obtain ⟨inner, accepted, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  exact ⟨g, (Bound4.accepted accepted).2⟩

private theorem metadata {s w p n label v risk t} (ok : Core8.metadata s w p n label v risk = some t) :
    Refines w ⟨p,n,.base (.advise label v.toNat)⟩ s t := by
  obtain ⟨h, hy, eq⟩ := Policy9.bound ok
  obtain ⟨inner, accepted, eqh⟩ := Policy9.bound hy
  cases Option.some.inj eq
  cases Option.some.inj eqh
  exact ⟨_, (Bound4.accepted accepted).2⟩

private theorem mapped {f : α → β} {o : Option α} {v : β} (h : o.map f = some v) :
    ∃ a, o = some a ∧ f a = v := by
  cases o with
  | none => contradiction
  | some a => exact ⟨a, rfl, Option.some.inj h⟩

private theorem baseRefines {s w t choice cmd}
    (ok : Policy9.applyBase s w choice cmd = some t) :
    ∃ f, entryFor w cmd = some f ∧ Refines w f s.base t := by
  cases cmd with
  | ordinary x extra =>
    obtain ⟨_, _, app⟩ := Policy9.bound ok
    exact ⟨_, rfl, appended app⟩
  | rebind p n keys ed ml =>
    obtain ⟨_, _, h⟩ := Policy9.bound ok
    obtain ⟨b, app, eq⟩ := Policy9.bound h
    cases Option.some.inj eq
    exact ⟨_, rfl, appended (t := b) app⟩
  | cancel p n d ed ml =>
    obtain ⟨_, _, h⟩ := Policy9.bound ok
    obtain ⟨_, _, h⟩ := Policy9.bound h
    exact ⟨_, rfl, filtered h⟩
  | issue p n last i ed ml =>
    obtain ⟨_, _, h⟩ := Policy9.bound ok
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    exact ⟨_, rfl, filtered h⟩
  | report p n i val fix =>
    obtain ⟨_, _, h⟩ := Policy9.bound ok
    exact ⟨_, rfl, appended h⟩
  | use i =>
    by_cases allowed : Policy9.grantOK s i = true
    · simp only [Policy9.applyBase, allowed, if_true] at ok
      obtain ⟨b, act, rfl⟩ := mapped ok
      obtain ⟨x, _, _, dec, _, bound, _⟩ := RiskWire8.act_ok act
      exact ⟨x.project, by simp [entryFor, dec], _, (Bound4.accepted bound).2⟩
    · simp [Policy9.applyBase, allowed] at ok
  | assessment =>
    simp only [Policy9.applyBase] at ok
    obtain ⟨b, act, rfl⟩ := mapped ok
    obtain ⟨_, _, h⟩ := Policy9.bound act
    obtain ⟨⟨p,n⟩, fields, h⟩ := Policy9.bound h
    obtain ⟨v, score, h⟩ := Policy9.bound h
    exact ⟨_, by simp [entryFor, fields, score], metadata (t := b) h⟩
  | threshold =>
    simp only [Policy9.applyBase] at ok
    obtain ⟨b, act, rfl⟩ := mapped ok
    obtain ⟨_, _, h⟩ := Policy9.bound act
    obtain ⟨⟨p,n⟩, fields, h⟩ := Policy9.bound h
    obtain ⟨v, level, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    exact ⟨_, by simp [entryFor, fields, level], metadata (t := b) h⟩

theorem step_projection {ctx w s t} (ok : Core9.step ctx w s = some t) :
    ∃ f g, projected w = some f ∧
      R2.next (fun _ => Bound4.digest w) (replacePool (ledger s) g) f = some (ledger t) := by
  by_cases tag : w[0]? = some (27 : UInt8)
  · obtain ⟨u, dec, _, install, _⟩ := Core9.package_admission tag ok
    exact ⟨_, _, by simp [projected, tag, dec], (Bound4.accepted (Upgrade9.install_ok install).2.2).2⟩
  · have policy : Policy9.step w s = some t := by simpa [Core9.step, tag] using ok
    obtain ⟨cmd, dec⟩ := Policy9.parsed policy
    obtain ⟨f, proj, g, transition⟩ := baseRefines (Policy9.ran dec policy).1
    exact ⟨f, g, by simp [projected, tag, dec, proj], transition⟩

def acceptedEntry (m : Ops) (ctx : Context) (s : State) : Input → List R2.Frame
  | .frame w => if (m.step ctx w s).isSome then (projected w).toList else []
  | _ => []

def acceptedHistory (m : Ops) (ctx : Context) (s : State) : List Input → List R2.Frame
  | [] => []
  | c :: cs => acceptedEntry m ctx s c ++ acceptedHistory m ctx (execute m ctx s c) cs

private theorem frameOrSame (ctx : Context) (s : State) (c : Input) :
    (ledger (execute newest ctx s c) = ledger s ∧ acceptedEntry newest ctx s c = []) ∨
    ∃ w f g, acceptedEntry newest ctx s c = [f] ∧
      R2.next (fun _ => Bound4.digest w) (replacePool (ledger s) g) f =
        some (ledger (execute newest ctx s c)) := by
  cases c with
  | reset | feed => exact .inl ⟨rfl, rfl⟩
  | stamp w =>
    cases ok : Core8.stamp w s.base with
    | none => exact .inl ⟨by simp [execute, newest, Core9.stamp, ok], rfl⟩
    | some b => exact .inl ⟨by simp [execute, newest, Core9.stamp, ok, (Stamp8.accepted ok).2], rfl⟩
  | frame w =>
    cases ok : Core9.step ctx w s with
    | none => exact .inl ⟨by simp [execute, newest, ok], by simp [acceptedEntry, newest, ok]⟩
    | some t =>
      obtain ⟨f,g,pr,h⟩ := step_projection ok
      exact .inr ⟨w,f,g,by simp [acceptedEntry, newest, ok, pr], by simpa [execute, newest, ok] using h⟩

private theorem history_eq (ctx s xs) :
    (ledger (run newest ctx s xs)).history = (ledger s).history ++ acceptedHistory newest ctx s xs := by
  induction xs generalizing s with
  | nil => simp [run, acceptedHistory]
  | cons c cs ih =>
    simp only [run, ih, acceptedHistory, ← List.append_assoc]
    congr 1
    rcases frameOrSame ctx s c with ⟨same, empty⟩ | ⟨w,f,g,one,h⟩
    · simp [same, empty]
    · rw [(R2.next_spec h).2, one]; rfl

private theorem preserve (p : R2.Ledger → Prop)
    (poolInvariant : ∀ s g, p s → p (replacePool s g))
    (nextInvariant : ∀ {s f t d}, R2.next d s f = some t → p s → p t)
    (ctx s xs) (initial : p (ledger s)) : p (ledger (run newest ctx s xs)) := by
  induction xs generalizing s with
  | nil => exact initial
  | cons c cs ih =>
    apply ih
    rcases frameOrSame ctx s c with ⟨same, _⟩ | ⟨_,_,_,_,h⟩
    · rw [same]; exact initial
    · exact nextInvariant h (poolInvariant _ _ initial)

private theorem initialLedger {key start} (ok : newest.genesis key = some start) :
    (ledger start).history = [] ∧ (ledger start).active = [] ∧
    (ledger start).book.seq = 0 ∧ (ledger start).book.claims = [] := by
  unfold newest Core9.genesis Policy9.genesis at ok
  obtain ⟨base, genesis, eq⟩ := mapped ok
  cases eq
  obtain ⟨_, _, h⟩ := Policy9.bound genesis
  obtain ⟨hy, hhy, eqh⟩ := Policy9.bound h
  cases Option.some.inj eqh
  unfold Hybrid7.genesis at hhy
  split at hhy
  · cases Option.some.inj hhy
    exact ⟨rfl,rfl,rfl,rfl⟩
  · contradiction

def RecordLaw (m : Ops) (start : State) : Prop :=
  (∀ ctx s xs, (ledger (run m ctx s xs)).history = (ledger s).history ++ acceptedHistory m ctx s xs) ∧
  ∀ ctx xs, R2.ViewSound (ledger (run m ctx start xs))

def StaleLaw (m : Ops) : Prop :=
  ∀ ctx s w f, projected w = some f → (f.parent ≠ (ledger s).head ∨ f.seq ≠ (ledger s).book.seq+1) →
    m.step ctx w s = none ∧ execute m ctx s (.frame w) = s

def MemoryLaw (m : Ops) (start : State) : Prop :=
  (∀ ctx s xs, ∃ suffix, (ledger (run m ctx s xs)).book.claims = (ledger s).book.claims ++ suffix) ∧
  (∀ ctx s w t f old replacement reason, m.step ctx w s = some t → projected w = some f →
      f.action = .base (.correct old replacement reason) → (ledger t).book.claims = (ledger s).book.claims) ∧
  ∀ ctx xs c, c ∈ (ledger (run m ctx start xs)).book.claims → Kira5.Origin (acceptedHistory m ctx start xs) c

/-- Historical confirmation can be read from the ledger separately from the latest outcome query. -/
def everConfirmed (s : State) (i : Intent) : Result :=
  if (ledger s).history.any (fun x => decide (x.action = .base (.outcome i .confirmed))) then .confirmed else .unknown

def HistoricalOutcomeLaw (m : Ops) (start : State) : Prop :=
  ∀ ctx xs i, let reported := ∃ f ∈ acceptedHistory m ctx start xs, f.action = .base (.outcome i .confirmed)
              let final := run m ctx start xs
              (everConfirmed final i = .confirmed ↔ reported) ∧ (everConfirmed final i = .unknown ↔ ¬ reported)

theorem newest_record {key start} (ok : newest.genesis key = some start) : RecordLaw newest start := by
  refine ⟨history_eq, fun ctx xs => preserve R2.ViewSound (fun _ _ h => h) ?_ ctx start xs ?_⟩
  · intro s f t d h valid
    simpa only [R2.step, h, Option.getD_some] using R2.view_step d s f valid
  · intro id mem; rw [(initialLedger ok).2.1] at mem; contradiction

theorem newest_stale : StaleLaw newest := by
  intro ctx s w f proj stale
  cases ok : Core9.step ctx w s with
  | none => exact ⟨ok, by simp [execute, newest, ok]⟩
  | some t =>
    obtain ⟨f', _, entry, h⟩ := step_projection ok
    cases Option.some.inj (entry.symm.trans proj)
    have a := (R2.next_spec h).1
    exact False.elim (stale.elim (fun bad => bad a.1) (fun bad => bad a.2.1))

theorem newest_memory {key start} (ok : newest.genesis key = some start) : MemoryLaw newest start := by
  constructor
  · intro ctx s xs
    induction xs generalizing s with
    | nil => exact ⟨[], by simp [run]⟩
    | cons c cs ih =>
      obtain ⟨tail, after⟩ := ih (execute newest ctx s c)
      rw [run, after]
      rcases frameOrSame ctx s c with ⟨same,_⟩ | ⟨w,f,g,_,h⟩
      · exact ⟨tail, by rw [same]⟩
      · exact ⟨Kira5.newClaims f.action ++ tail, by rw [(R2.next_spec h).2]; simp [R2.append, Kira5.book_claims]⟩
  constructor
  · intro ctx s w t f old replacement reason step proj action
    obtain ⟨f', _, dec, h⟩ := step_projection step
    cases Option.some.inj (dec.symm.trans proj)
    rw [(R2.next_spec h).2]
    simp [R2.append, Kira5.book_claims, action, Kira5.newClaims]
  · intro ctx xs c held
    have valid : Kira5.Valid (ledger start) := by
      constructor
      · intro n pos le; rw [(initialLedger ok).2.2.1] at le; omega
      · intro c hc; rw [(initialLedger ok).2.2.2] at hc; contradiction
    have transfer (s : R2.Ledger) (g : List Intent) (v : Kira5.Valid s) : Kira5.Valid (replacePool s g) := by
      constructor
      · exact Kira5.Valid.numbered (s := s) v
      · exact Kira5.Valid.sourced (s := s) v
    have result := Kira5.Valid.sourced (preserve Kira5.Valid transfer
      (fun h v => Kira5.ledger_valid h v) ctx start xs valid) c held
    simpa only [history_eq, (initialLedger ok).1, List.nil_append] using result

theorem newest_historicalOutcome {key start} (ok : newest.genesis key = some start) : HistoricalOutcomeLaw newest start := by
  intro ctx xs i
  dsimp only
  unfold everConfirmed
  rw [history_eq, (initialLedger ok).1, List.nil_append]
  change ((if (acceptedHistory newest ctx start xs).any _ then _ else _) = _ ↔ _) ∧ _
  by_cases h : ∃ f ∈ acceptedHistory newest ctx start xs, f.action = .base (.outcome i .confirmed)
  · have hit : (acceptedHistory newest ctx start xs).any (fun f => decide (f.action = .base (.outcome i .confirmed))) = true := by simpa using h
    simp [hit, h, Bound4.initial, R2.initial]
  · have miss : (acceptedHistory newest ctx start xs).any (fun f => decide (f.action = .base (.outcome i .confirmed))) = false := by simpa using h
    simp [miss, h, Bound4.initial, R2.initial]

end Aukora.Release
