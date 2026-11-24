# Conformance corpus

Each group starts in a fresh instance with head and installed digest both zero. Initialize with the raw 1,984 bytes of `../fixtures/signed/keys.bin`. For `gate`, use `../fixtures/install/keys.bin` and stage the exact bytes of `../fixtures/fixed-genesis.wasm` before the first frame. The supplied runner feeds the file in 8 KiB chunks.

A group has a UTF-8 TSV manifest without a header and a gzip-compressed concatenation of all its frames. In each TSV row, the four tab-delimited columns are the label, byte length in decimal, expected `step()` result (0 or 1), and expected resulting head (64 lowercase hex digits). Read precisely the indicated number of uncompressed bytes, submit using the byte ABI, and compare both fields. Honor zero-length entries and the entry exceeding the input capacity. Call `step()` even after an `input` refusal. Continue from the resulting state. A rejected frame retains the prior head. Each group is independent.

| Group | Workload |
| --- | --- |
| matrix | Per-action header and payload mutations, all 256 outer tags, all 256 inner tags, the reserved version escape, mixed successful and rejected submissions |
| length | Exact lengths and neighboring values, 16-bit payload boundaries, UTF-8 decoding, 1 MiB combined certificate limit, ABI buffer boundary |
| history | First reports, stale retransmissions, unlabelled replacements, corrections before a report, and multiple successive labelled corrections across 32 intents |
| signed | 22 signed-session operations with exact, one-byte-short and one-byte-long submissions. Several operations are unsigned parts of the same history. |
| gate | A hybrid install grant, truncated and extended packages, a successful installation, and a replay after the grant has been consumed |

From the lab root, `node v0.1/tests/replay.mjs` replays these files on the release Wasm. The runner accepts an alternate corpus directory and an optional Wasm path as positional arguments. `sh v0.1/tests/conformance.sh` uses the built archives and pinned environment in the release build directory to generate the reference states again, replay the new bytes and compare them byte-for-byte with this corpus.
