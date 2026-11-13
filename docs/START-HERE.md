# Start here

English | [中文](START-HERE.zh.md)

Aukora is the name of the product direction in this checkout: a user-owned, local-first environment for an AI that can change its own modules and can show what changed. The code under that name is DeepSeek Harness, an all-plugin agent runtime, and Cordis, the plugin system those plugins run on. **SOURCE.** That is a reading of `README.md`, `AGENTS.md`, and `vendor/cordis`. **PROPOSED.** "User-owned" and "self-modification with verifiable continuity" are the aim. They are not a measured property of the running system.

Three places can hold or publish a ball. The browser runs a Web Worker. A local Node process serves this machine. A Cloudflare Worker forwards to Durable Objects. A fourth door is the path model traffic takes when the worker rewrites a provider URL onto `/door/<name>/`. They are four roles, not one process, and this page does not claim they were booted together. **UNPERFORMED.** Live local-machine deployment and in-browser checks are not recorded here. One boot of the local Node process by the authors, signed out and with no browser, is in [RUN-RECORD.md](RUN-RECORD.md); it is a **REPORTED RUN** (a record of an earlier tree). When someone reports those runs, label them **REPORTED RUN**, not **OBSERVED RUN**.

A ball is a content-addressed bundle of modules. An organ is one Cordis plugin entry in that bundle. An epoch is the integer version on the manifest. A receipt is one append-only line in a hash chain. An Ed25519 checkpoint authenticates a prefix of that chain. The receipt line itself is not a signature. **SOURCE.** `seed-receipts.js` appends a leaf with `prevHash` and `leafHash`. The checkpoint action is the step that signs. Host publication of a ball checks a content hash and a parent step of one epoch. It does not check an Ed25519 manifest signature. **PROPOSED.** That signature envelope is described in `ARCHITECTURE-ACTUAL.md`. Server enforcement of it is **UNPERFORMED**.

Read next: the actual file map ([ARCHITECTURE-ACTUAL.md](ARCHITECTURE-ACTUAL.md)), then the glossary ([GLOSSARY.md](GLOSSARY.md)).

## Four roles

```text
Browser WebWorker          Local Host                 Cloudflare DO mirror         Model Door
ball-loader.ts             server/local-host.mjs      deploy/cloudflare/src/       model-doors.ts
connectWorkerHost          server/ball-head.mjs       worker.mjs, head-do.mjs,     /door/<provider>/
                                                      mirror-do.mjs
```

**SOURCE.** File names above are in this checkout. File and symbol pins are in [ARCHITECTURE-ACTUAL.md](ARCHITECTURE-ACTUAL.md).

## Package map

| Path | What it is |
|---|---|
| `vendor/` | Pinned Cordis and its libraries |
| `packages/` | `@deepseek-ai/dsh-*` workspaces |
| `apps/web` | Web frontend, including `src/spatial/superagent` |
| `server/` | Local host, ball head, preview build |
| `deploy/cloudflare` | Worker and Durable Object head/mirror |
| `mirror/` | Genesis seed: ball head, seed organs, Pearl seed files |
| `docs/` | Harness docs plus the Aukora pages in the reading order |

**SOURCE.** The group list matches the top of `AGENTS.md` and the directories in this checkout. It is not a claim that every package is part of the Aukora product surface.

## Five risks

1. **SOURCE.** Root `package.json` says `AGPL-3.0-or-later`. The root `LICENSE` file is AGPL-3.0 text. Dependency licenses are separate. Nobody should treat one file as a relicensing of the others.
2. **SOURCE.** `mirror/` holds only the genesis seed: the head, the seed organs and two Pearl seed files. A node writes its own world there at run time, and `.gitignore` keeps that world out of the repository.
3. **SOURCE.** A parent id on `HEAD.json` is a claim. An intact promote edge is a hash-chain link, not owner confirmation. A checkpoint is not a passkey. A later ball does not inherit `owner-confirmed`.
4. **SOURCE.** Host publish requires the child epoch to be the selected epoch plus one (`server/ball-head.mjs`). The receipt log does not enforce that rule for every kind. Do not assume epoch monotonicity everywhere.
5. **UNPERFORMED.** This page does not record a booted browser or a Cloudflare deployment. One boot of the local host is recorded in [RUN-RECORD.md](RUN-RECORD.md) as a **REPORTED RUN** (a record of an earlier tree). Unit tests of the readout do not close that gap.
