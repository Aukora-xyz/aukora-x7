# Changelog

## Unreleased

- Added the earlier research builds (v0.2 to v0.7), the research notes in `docs/`, the evidence and lab folders, and the release-assembly tooling.
- Added a Linux smoke workflow for shipped artifacts. It does not build the Apple-silicon toolchain or establish source reproducibility.
- Documented the short sample replay, known limits, and optional backup-check skips.

## v0.8 (research release)

- Shipped the Lean model (44 named laws for one model), lite/full Wasm, v0.8 adapter, public sample and release fingerprints.
- Published the wire format, proof scope and explicit limits. Two open defects: the old approval/key-change forms lack record binding, and long histories can trap. The release is a witness, not a live enforcement boundary.
- Documented same-machine v0.8 rebuild evidence and the separate, unverified independent empty-folder rebuild of the exact public export.

## Experimental lines (not releases)

- **v0.9:** decoder/form-table work. It does not refuse the old forms.
- **v0.10:** conditional refusal of two decoded forms in tested bound records; old-start behavior remains exposed. Built twice on one Apple-silicon Mac by two builders, byte-identical (second builder's report); no rebuild on other hardware or by an outside party.
- **standalone-next, bailiff-rehearsal, skunkworks:** a bound-record adapter, effect-sink rehearsal and lab checks. None governs live effects. See [NEXT-LINE](NEXT-LINE.md).
