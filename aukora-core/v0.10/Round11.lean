import Ratchet11
import Safe11
import Evidence11

namespace Aukora.Round11
open R6.KernelCell (Context)

/-- Full lab admission path (the INNER step). The ratchet-compatible successor uses Ratchet11.step. The exported
    public step (`Public.step`) refuses an input of a refused form first. -/
def step (ctx : Context) :=
  Safe11.step (Evidence11.step (Ratchet11.step ctx))

@[export r11_halted] def halted (s : Policy9.Machine) : UInt32 :=
  if Safe11.halted s then 1 else 0

@[export r11_ceiling] def ceiling (s : Policy9.Machine) := (Evidence11.ceiling s).toUInt32

/-- The host view caches these exact bytes when genesis or an install commits. -/
@[export r11_law_digest] def lawDigest (ctx : Context) (s : Policy9.Machine) :=
  (Ratchet11.lawDigest ctx s).toByteArray

end Aukora.Round11
