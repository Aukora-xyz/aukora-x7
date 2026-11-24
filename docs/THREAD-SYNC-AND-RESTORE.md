# Thread sync and restore

**SOURCE:** Thread sync reads or appends conversation data for an existing node. The supported snapshot path can seed an empty Cloudflare edge or resume an interrupted restore for the same seed. Neither operation replaces owner enrollment.

## Thread sync

- **SOURCE:** The writer sends settled conversation entries to the edge. The append path requires a writer lease and checks the acknowledged position. An already acknowledged retry is not an instruction to replace what is stored.
- **SOURCE:** A reader can pull eligible threads within size limits; the separate newest-conversation window is bounded, depends on a usable checkpoint and displays complete messages only. It is neither the whole thread nor a write grant.
- **SOURCE · Synthetic example:** A test thread has acknowledged entries `alpha` and `beta`. A compatible writer can append `gamma`. The divergence checks refuse a stale append that disagrees with the acknowledged prefix instead of replacing `beta`.

## Restore

- **SOURCE:** The snapshot path checks required parts, sizes, hashes and the manifest. Preview writes nothing. After explicit confirmation, the code rechecks the edge and writes only to an empty edge or a partial restore with the same seed. For initialized state it reports a comparison and refuses a different state.
- **SOURCE · Synthetic example:** A test snapshot holds a manifest, module bytes and eligible mirrored files. A damaged module fails verification before seeding. A matching preview is not itself a write or evidence that the snapshot is the most recent one.
- **SOURCE:** The snapshot path does not restore the original owner binding or passkey, Messages, the turn journal, the provider budget, or earlier HEAD history. A nightly paged copy is separate from snapshot restore.
- **UNVERIFIED:** A live snapshot restore and recovery from distributed shards remain unverified. Snapshot verification alone does not establish complete capture, continuity of the same agent or recovery of the original owner authority.

**SOURCE:** Source entry points are `deploy/cloudflare/src/thread-log.mjs`, `packages/experimental/webworker-runtime/src/storage/thread-sync.ts`, and `deploy/cloudflare/src/recovery-restore.mjs`. Test evidence in the source tree includes `thread-log.test.mjs`, `thread-sync.spec.ts`, `recovery-restore.test.mjs`, and `nightly-copy.test.mjs`. For orientation see [Start here](START-HERE.md). **UNVERIFIED:** Those tests were read, not rerun for this page.
