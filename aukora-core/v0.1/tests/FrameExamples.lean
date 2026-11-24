import Proofs.FrameLaws

namespace Aukora.R2
namespace Witness
def start := initial ⟨[0]⟩ ⟨[1]⟩ "owner"
def hash (_ : Frame) : Digest := ⟨[7]⟩
def pack (s : Ledger) (e : Action) : Frame := ⟨s.head, s.book.seq + 1, e⟩
def walk (s : Ledger) (es : List Action) : Ledger :=
  es.foldl (fun st e => step hash st (pack st e)) s
def decisions : Ledger → List Action → List Bool
  | _, [] => []
  | s, e :: es =>
    let result := next hash s (pack s e)
    result.isSome :: decisions (result.getD s) es

theorem retract_witness :
    let es := [.base (.say "keep"), .base (.say "removed"), .retract 1 true, .base (.say "new")]
    let s := walk start es
    decisions start es = [true, true, true, true] ∧
    s.active = [3,0] ∧ lineAt s.history 1 = some "removed" ∧ lineAt s.history 3 = some "new" := by decide
#print axioms retract_witness

def delivery : Intent := ⟨.deliver [42], "service", 0, 3⟩
def permit : Mandate := ⟨"service", [42], 0, 1, 10⟩
theorem mandate_witness :
    decisions start [.mandate permit true, .useMandate 0 (.upgrade ⟨[0]⟩ true delivery),
      .useMandate 0 (.rebind "other" true), .useMandate 0 (.act {delivery with audience := "other"}),
      .useMandate 0 (.act delivery), .useMandate 0 (.act delivery)] =
      [true, false, false, false, true, false] ∧
    decisions start [.mandate {permit with expiry := 2} true, .base (.say "tick"), .useMandate 0 (.act delivery)] =
      [true, true, false] := by decide
#print axioms mandate_witness

theorem spend_witness :
    let es := [.grantBudget ⟨0, 5⟩ true, .spend 0 2, .spend 0 4, .spend 0 3, .grantBudget ⟨0, 8⟩ true,
      .spend 0 1, .spend 3 7]
    decisions start es = [true,true,false,true,true,false,true] ∧
    total (walk start es).history .money 0 = 5 ∧ total (walk start es).history .money 3 = 7 := by decide
#print axioms spend_witness

def passA : Pass := ⟨"outside", "thread", 0, 10⟩
theorem pass_witness :
    decisions start [.pass passA true, .read 0 "other" "thread" true, .read 0 "outside" "thread" false,
      .read 0 "outside" "thread" true, .revoke 0 true, .pass passA true,
      .read 0 "outside" "thread" true, .read 3 "outside" "thread" true] =
      [true,false,false,true,true,true,false,true] ∧
    decisions start [.pass {passA with expiry := 2} true, .read 0 "outside" "thread" true,
      .read 0 "outside" "thread" true] = [true,true,false] := by decide
#print axioms pass_witness

end Witness
end Aukora.R2
