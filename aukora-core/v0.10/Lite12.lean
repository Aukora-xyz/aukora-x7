import Lite
import Round11

namespace Aukora.Lite12

/-- Replay the full evidence and recovery format without loading a checker environment. -/
def step (wire : ByteArray) (s : Policy9.Machine) : Option Policy9.Machine :=
  Safe11.step (Evidence11.step Lite.step) wire s

end Aukora.Lite12
