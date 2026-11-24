import Round11

namespace Aukora.Judge12
/-- The host ABI reads only the exact staging bytes of its current private state. -/
@[export r12_staged] def staged (s : Policy9.Machine) := s.base.hybrid.inner.candidate

@[export r12_digest] def digest (b : ByteArray) := (Sha256.hash b).toByteArray
end Aukora.Judge12
