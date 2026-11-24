import Xor

open PCW

def main : IO Unit := do
  let some n := decode xorBytes | throw (IO.userError "XOR payload failed to decode")
  let pairs : List Input := [(false,false), (false,true), (true,false), (true,true)]
  let cases := pairs.map fun v => [bit v.1, bit v.2, run n v]
  IO.println ("{\"weights\":" ++ toString xorBytes ++ ",\"cases\":" ++ toString cases ++ "}")
