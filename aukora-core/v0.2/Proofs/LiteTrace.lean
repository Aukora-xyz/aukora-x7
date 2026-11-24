import ReleaseInterface
import Lite

namespace Aukora.Release

def lite : Model := {newest with step := fun _ => Lite.step}

def replayInput : Input → Bool
  | .frame w => w[0]? != some (27 : UInt8)
  | _ => true

theorem lite_replay (ctx s xs) :
    run lite ctx s xs = run newest ctx s (xs.filter replayInput) := by
  induction xs generalizing s with
  | nil => rfl
  | cons cmd cs ih =>
    cases cmd with
    | feed | stamp | reset => exact ih _
    | frame w =>
      by_cases install : w[0]? = some (27 : UInt8)
      · simp [run, replayInput, install, execute, lite, Lite.step]; exact ih _
      · simp [run, replayInput, install, execute, lite, Lite.ordinary ctx w s install, newest]; exact ih _

#print axioms lite_replay
end Aukora.Release
