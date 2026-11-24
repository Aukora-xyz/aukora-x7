import Mutations

open PCW

-- Intentional failure 1. Same bytes, false specification. Input (false,true) distinguishes them.
example : Meets xorNet andSpec := by decide

-- Intentional failure 2. The new bytes still compute XOR, but the old evidence has the wrong type.
example : Certificate [1,254,0,255,1,0,1,1,0] xorSpec := xor_certificate
