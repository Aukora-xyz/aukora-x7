# Threat model

**SOURCE · Scope:** X7 is designed to limit what an agent or model reply can do through the reviewed approval, promotion and repository-merge paths. A proposal, a model output, or a read-only session is not authorization to perform a protected change.

## What the source tests cover

| Concern | Control | Test file |
|---|---|---|
| **SOURCE:** Unauthorized or replayed sign-in | Passkey verification checks the ceremony binding. A sign-in session is not a protected-action approval. | `owner-passkey-signin.test.mjs` |
| **SOURCE:** A changed staged proposal or reused approval | The merge approval binds the staged change. Tests cover single use and unresolved outcomes. | `head-repo-proposal.test.mjs` |
| **SOURCE:** A scoped grant is treated as unlimited | The ordinary-change grant has limits and does not authorize protected changes. | `night-grant.test.mjs` |
| **SOURCE:** A stale writer replaces acknowledged thread data | The append path checks the writer lease and the acknowledged prefix. | `thread-log.test.mjs` |
| **SOURCE:** Invalid snapshot or overwriting initialized state | Restore validates before writing and does not overwrite a newer or different initialized destination. | `recovery-restore.test.mjs` |

## What this does not cover

- **SOURCE:** The approval page, browser, authenticator, edge and current storage are trusted for these checks. These controls do not protect against a compromised approval page or edge operator, stolen deployment credentials, or changes made outside the reviewed paths.
- **SOURCE:** One-use approval depends on preserved state. `aumlok-restore-rehearsal.test.mjs` documents storage rollback limits, not a guarantee against rollback.
- **SOURCE:** The [Core overview](CORE.md) describes a separate evidence reader. A replay checks a disclosed record; it does not establish that all actions were recorded or that a claimed outside effect happened.
- **UNVERIFIED:** The test files were inspected, not rerun for this page. This is not an independent security audit, a claim about a live deployment, or proof of complete recovery of owner authority.
