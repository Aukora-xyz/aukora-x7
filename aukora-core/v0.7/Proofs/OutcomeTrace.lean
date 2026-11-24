import ReleaseInterface
import Proofs.Stamp

namespace Aukora.Release
open R6.KernelCell (Context)
open private Policy9.ran Policy9.parsed from Proofs.Policy

/-- Only a successfully parsed original or correction contributes a finding. -/
def wireFinding (w : ByteArray) : Option Policy9.Finding := do
  guard (w[0]? != some (27 : UInt8))
  let .report _ _ i v fix ← Policy9.decode w | none
  return ⟨Risk8.intentDigest i, i, v, fix⟩

def findingAt (m : Ops) (ctx : Context) (s : State) : Input → List Policy9.Finding
  | .frame w => if (m.step ctx w s).isSome then (wireFinding w).toList else []
  | _ => []

/-- The decoder preserves the correction label. Newest findings come first, as in the Wasm view. -/
def findingsIn (m : Ops) (ctx : Context) (s : State) : List Input → List Policy9.Finding
  | [] => []
  | c :: cs => findingsIn m ctx (execute m ctx s c) cs ++ findingAt m ctx s c

def OutcomeTraceLaw (m : Ops) (start : State) : Prop :=
  ∀ ctx xs key, let found := findingsIn m ctx start xs
    let final := run m ctx start xs
    final.outcomes = found ∧ m.outcome final key = Policy9.outcomeCode {final with outcomes := found} key

private theorem submittedFinding {w s t ctx} (ok : Core9.step ctx w s = some t) :
    t.outcomes = (wireFinding w).toList ++ s.outcomes := by
  by_cases tag : w[0]? = some (27 : UInt8)
  · obtain ⟨_, _, _, _, _, same, _⟩ := Core9.package_admission tag ok
    simpa [wireFinding, tag, guard] using same
  have p : Policy9.step w s = some t := by simpa [Core9.step,tag] using ok
  obtain ⟨cmd, dec⟩ := Policy9.parsed p
  have outcomes := (Policy9.ran dec p).2.2
  cases cmd <;> simpa [wireFinding,tag,dec,guard,Policy9.outcomesAfter] using outcomes

private theorem commandFinding (ctx s c) :
    (execute newest ctx s c).outcomes = findingAt newest ctx s c ++ s.outcomes := by
  cases c with
  | reset | feed => rfl
  | frame w =>
    cases ok : Core9.step ctx w s with
    | none => simp [execute,newest,findingAt,ok]
    | some t => simpa [execute,newest,findingAt,ok] using submittedFinding ok
  | stamp w =>
    cases b : Core8.stamp w s.base <;> simp [execute,newest,Core9.stamp,findingAt,b]

private theorem trace (ctx s xs) :
    (run newest ctx s xs).outcomes = findingsIn newest ctx s xs ++ s.outcomes := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih => simp only [run,findingsIn,ih,commandFinding,List.append_assoc]

theorem newest_outcomeTrace {keys start} (ok : newest.genesis keys = some start) : OutcomeTraceLaw newest start := by
  have empty : start.outcomes = [] := by
    change (Core8.genesis keys).map _ = some start at ok
    obtain ⟨b,_,eq⟩ := Option.map_eq_some'.mp ok
    subst start
    rfl
  intro ctx xs key
  dsimp only
  have found := trace ctx start xs
  rw [empty,List.append_nil] at found
  exact ⟨found, by change Policy9.outcomeCode _ key = _; rw [← found]⟩

end Aukora.Release
