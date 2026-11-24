-- Returning a grown array requires Lean's allocation and ownership machinery.
@[export append_marker]
def appendMarker (xs : ByteArray) : ByteArray := xs.push 42
