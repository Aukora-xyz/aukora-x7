Three checks written independently of the builder's tests. Run each with a core file:

    node v0.8/tests/independent/readdress.mjs v0.8/aukora-core-lite.wasm
    node v0.8/tests/independent/bound-edges.mjs v0.8/aukora-core-lite.wasm
    node v0.8/tests/independent/twin-cores.mjs <core A> <core B>     (the same bytes into two cores, compared after every input)
