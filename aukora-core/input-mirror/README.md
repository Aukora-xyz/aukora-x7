# Input mirror for the v0.1 rebuild
Six lab outputs that `v0.1/INPUTS.sha256` pins and that had no retrievable copy (found by the outside rebuild
lane). Paths below this folder equal the pinned relative paths, so a fetch script can use this folder as its
mirror root. Each file's SHA-256 is the value in `v0.1/INPUTS.sha256`; check it, do not trust this folder.
The four toolchain pins are ARM64 macOS executables. A Linux rebuild needs its own toolchain pins and a build
script that checks inputs per platform; that is not built yet.
