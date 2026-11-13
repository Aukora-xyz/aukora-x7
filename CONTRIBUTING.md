# Contributing

English | [中文](CONTRIBUTING.zh.md)

Aukora is building a personally owned AI that can change its own software, while a separate authority keeps the person who owns it in control of sensitive actions. This page says how to get the code, check it, and send a change.

The rule the code is built around is also the rule for contributing: **what proposes never permits.** Auma, the AI in this repository, can write and stage a new version of herself, but only the owner can make it live: a passkey approval for her protected modules, an owner sign-in session for an ordinary one ([SECURITY.md](SECURITY.md), claim 3), both checked by a separate program, the edge. Here, your pull request is the proposal and a maintainer's review is the approval. The same holds if you are an AI agent opening the pull request.

This page replaces the inherited upstream guide, which said outside pull requests could not be accepted. This project accepts them. `CONTRIBUTING.zh.md` is the Chinese twin of this page; where the two differ, this page applies.

Maturity labels used on this page and in every new claim you write:

| Label | Meaning |
| --- | --- |
| IMPLEMENTED | Code and tests are in this tree. |
| RECORDED RUN (of an earlier tree) | Shown in [docs/RUN-RECORD.md](docs/RUN-RECORD.md). |
| INDEPENDENTLY VERIFIED | Run by someone other than the authors. Nothing has this label yet. |
| UNVERIFIED | Claimed or written, but no test here holds it or no run shows it. |
| DIRECTION | Not built. |

## 1. Get the code

```text
git clone https://github.com/Aukora-xyz/aukora-x7
cd aukora-x7
```

The public history of this repository starts at its first public commit; the project's earlier history is not public. A few checks that compare files against Git history cannot run here (for example `server/aura.test.mjs`, which skips its provenance case; see `server/fixtures/organs/pinned.mjs`).

## 2. One command, no install

```text
node scripts/verify-lite.mjs
```

- Needs Node 24.9 or newer and nothing else. It runs 22 test files one at a time with Node's own test runner, compares each file's failure count with that file's row in [docs/KNOWN-RED-TESTS.md](docs/KNOWN-RED-TESTS.md), and exits 0 only when every failure is on that list.
- The last line it prints should read: `verify-lite: 22 files, 564 pass, 12 fail, 12 of 12 on the known-red list`. This was seen on one machine (Node 24.11.1), three runs in a row, each in 40 to 45 seconds. That is not in the run record (of an earlier tree), so treat it as UNVERIFIED until you see it yourself.
- The 12 failures are in three files: `server/memory.test.mjs` 3, `server/predict.test.mjs` 6 and `server/receipts-policy.test.mjs` 3. This is a different and much smaller run than the recorded one (of an earlier tree) in section 3, so its numbers are not the state of the project.
- It does **not** run the authority tests: the approval spent once, the proof-failure rule, the owner-only ids, the night grant (one passkey approval that covers a bounded set of later ordinary changes), the transition classifier and the rollback gap reproduction. Those import npm packages this repository does not ship. The script says so in its output.
- `--with-packages` adds 16 authority test files after an install. That option is UNVERIFIED: nobody has run it from a clean install.
- It is a smoke check for a fresh clone, not proof that the authority rule holds.

## 3. Install and run the full suites

These are the steps of the one recorded run (of an earlier tree), taken from [docs/RUN-RECORD.md](docs/RUN-RECORD.md). That run was on one machine (Node v24.11.1, pnpm 11.28.5, vitest 4.1.11), with `HOME`, the XDG folders, the npm cache and `TMPDIR` pointed at a scratch folder, and one heavy step at a time. Do the same: set `HOME` to an empty folder.

| Step | Command | Recorded result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | RECORDED RUN (of an earlier tree) used `--offline --store-dir <a local pnpm store>` with registry metadata already in the cache: 1,458 packages. An online install is not recorded: UNVERIFIED. |
| Build | `DSH_CLIENT_COMMIT_HASH=0000000 PORT=<a free port> node server/build-preview.mjs` | RECORDED RUN (of an earlier tree): exit 0, 260 files in `apps/web/dist`. `NODE_OPTIONS=--max-old-space-size=5632` was set. |
| Boot | `PORT=<a free port> X6_OWNER_EMAIL=<made up> X6_OWNER_PUBLIC_KEY_HEX=<64 random hex> pnpm run x6:start` | RECORDED RUN (of an earlier tree): the local host listened on 127.0.0.1 and was stopped with SIGTERM. |
| Dry run | `node server/cloudflare-bootstrap-cli.mjs --dry-run` | RECORDED RUN (of an earlier tree): ball `a26b7a027014e6af067a0a8433c49c56639ac09642726110c91f8300e9e81624`, epoch 1. A ball is the manifest that names every organ (a replaceable module of Auma) by hash; its epoch is its version number. |

Two warnings:

- `server/build-preview.mjs` posts to a host on `http://127.0.0.1` at `PORT` (default 4610) before and after it builds (`server/build-preview.mjs`, lines 43 to 55). A program listening there is changed. Always set `PORT` to a port nothing listens on.
- In a copy without `.git`, the build exits 1 unless `DSH_CLIENT_COMMIT_HASH` is set (any 7 to 40 hex digits). Do not start with `pnpm run x6:build`; it is reported to fail on a fresh clone (UNVERIFIED).

The test suites:

| Suite | Command | Cases | Pass | Fail |
| --- | --- | ---: | ---: | ---: |
| Node, 107 files | `node --test server/*.test.mjs deploy/ci/*.test.mjs deploy/cloudflare/src/__tests__/*.test.mjs` | 2,581 | 2,486 | 82 (and 1 skipped, 12 todo) |
| Edge Worker | `node --test deploy/cloudflare/src/__tests__/worker.spec.ts` | 98 | 93 | 5 |
| App | `pnpm exec vitest run packages/client/ui-layout/tests scripts/spatial-catalogue.spec.ts --maxWorkers=3` | 1,112 | 1,112 | 0 |
| Runtime | `pnpm exec vitest run packages/experimental/webworker-runtime/tests --maxWorkers=3` | 1,711 | 1,708 | 3 |
| All | | 5,502 | 5,399 | 90 |

All of these numbers are RECORDED RUN (of an earlier tree). 89 of the 90 failures are on the red list; the 90th (`packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts`, "execa refuses 1 called symbol(s)") was found by that run and is now listed. On macOS and Windows, `vitest.config.ts` leaves out two runtime specs that only run on Linux.

That run had no browser session, no Cloudflare deployment, no model call and no passkey ceremony. A pass on your machine does not cover those either.

## 4. Read the red list

[docs/KNOWN-RED-TESTS.md](docs/KNOWN-RED-TESTS.md) lists every test known to fail, with its count and the reason, or says the cause has not been investigated. Compare your failures with it.

- A failure that is not on the list is news. Say so in your pull request, or open an issue.
- Never add a row to the list to make your own change pass. A new row needs its own reason and a maintainer's agreement.
- Turning a red row green is one of the most useful changes you can make. See [docs/GOOD-FIRST-CONTRIBUTIONS.md](docs/GOOD-FIRST-CONTRIBUTIONS.md).

## 5. Send a change

1. Fork, make a branch, keep the change small and about one thing.
2. Run what touches your change: `node scripts/verify-lite.mjs` at least, and the suite that holds the files you changed.
3. Open a pull request. Say what changed and why, which commands you ran with their pass and fail counts, any failure that is not on the red list, and the maturity label of every claim you add to a page.
4. Expect a maintainer to run your tests again before approving.

Things to know before you do:

- **No checks run on a pull request.** Every workflow in `.github/workflows/` has its automatic triggers commented out and only manual dispatch is live (three reusable workflows can also be called by another workflow). Reviewers rely on what you report and what they run themselves.
- **The issue and pull request templates are inherited and in Chinese** (`.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`), and blank issues are switched off in `.github/ISSUE_TEMPLATE/config.yml`. Write in English or Chinese and skip template fields that do not apply. Replacing the templates is a welcome change.
- **The inherited review automation** in `.github/review-ownership/` is not how this project reviews; its workflow is switched off.
- **Paired pages.** Most pages under `docs/` and some root pages have a Chinese twin (`*.zh.md`) and a pairing record (`*.i18n.yaml`), checked by `scripts/verify-translation-pairing.ts` (`pnpm run verify-translation-pairing`). This is inherited. The new front pages have twins and records too; where a twin differs from its English page, the English page applies. If you change an English page that has a twin, say in the pull request whether the twin still matches.
- **`AGENTS.md` at the root is the inherited harness's coding guide,** apart from a pointer at its top. It does not describe Aukora's rule. Start from [docs/AI-START-HERE.md](docs/AI-START-HERE.md) instead.
- **Licence and terms.** The repository is AGPL-3.0-or-later ([LICENSE](LICENSE)). There is no contributor agreement and no sign-off rule yet, and the copyright holders are not named ([docs/OPEN-SOURCE-READINESS.md](docs/OPEN-SOURCE-READINESS.md)). Until there are, state in your pull request that you offer the change under AGPL-3.0-or-later.
- **Security flaws** go through [SECURITY.md](SECURITY.md), not a public issue.

## House rules

These are the project's own mechanics, applied to its own development.

**1. A pull request is a proposal.** Opening one gives it no authority, in the same way that Auma staging a candidate does not select it (`stage_organ_promotion` in `packages/experimental/webworker-runtime/src/x6/ball-loader.ts` posts to `/_head/stage`; only the owner's approval moves the head in `deploy/cloudflare/src/head-do.mjs`).

**2. A maintainer's review is the approval, on exact bytes.** An approval covers the commit that was reviewed. A push after approval needs a new review. This mirrors the edge, which binds a passkey approval to the body hash of one request and spends it once (`aumlokClass3Binding` in `deploy/cloudflare/src/aumlok.mjs`; tests `convergence-approval-fencing.test.mjs` and `head-hardening.test.mjs` in `deploy/cloudflare/src/__tests__/`).

**3. No test, cap or gate is weakened to get green.** Do not delete, skip or loosen a test, raise a limit, add an exception, or move a failure onto the red list to pass. The open-exception list in `deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs` is empty and stays empty unless a reviewed change argues otherwise. If you believe a test is wrong, say why in the pull request and change it in its own commit, with the original intent still asserted.

**4. A rejected design is written down as a lesson.** When a maintainer rejects a design, the reason goes in the pull request thread, where the next person can find it. When the lesson is one the system must not forget, propose it as a scar: one line in `mirror/home/auma/seed/scars.jsonl` with the failure, the lesson and the checks that guard it, and those checks added as cases of the retention suite `mirror/home/auma/seed/pearl/retention-suite.v1.json`. Six scars ship today. Scars and the retention suite are on the authority list under rule 6, so that rule applies.

**5. Honesty labels on every claim.** Every sentence you add about what the code does names a file that exists and, where there is one, the test that holds it, with one of the five labels above. Older pages use other words (SOURCE, PROPOSED, UNPERFORMED, REPORTED RUN, RAN); new text uses the five. Never turn a goal into a feature: if it is not built, it is DIRECTION. Never write a number you did not count, and say how you counted it.

**6. Authority files get a second reviewer.** A change to any file below, or to its tests, needs a second reviewer besides the maintainer who approves it, and neither may be its author. These files hold the line between what proposes and what permits.

| Area | Files |
| --- | --- |
| Approval, identity and sign-in | `deploy/cloudflare/src/aumlok.mjs`, `owner-grant-policy.mjs`, `proof-failure-rule.mjs`, `webauthn-screen.mjs`, `passkey-devices.mjs`, `gate-lockout.mjs`, `owner-login-slots.mjs`, `access.mjs`, `enrollment-approval.mjs`, `signed-action.mjs` |
| Head, grants and promotion | `deploy/cloudflare/src/head-do.mjs`, `night-grant.mjs`, `organ-set-rule.mjs`, `worker.mjs`, `cloud-brokers.mjs` (publication approval) |
| Recovery | `deploy/cloudflare/src/recovery-restore.mjs`, `rescue-kit.mjs`, `vault.mjs`, `cold-archive.mjs` |
| Transition rules | `server/ball-transition.mjs` (the owner-only list `T2_ONLY_ORGANS`), `server/ball-head.mjs`, `server/owner-grant.mjs` |
| Agent side copies and pins | `packages/experimental/webworker-runtime/src/x6/ball-loader.ts`, `wasm-cells.ts`, `scion.ts`, `scion-pins.ts`, `scion-growth.ts` |
| Approval screens | `packages/client/ui-layout/src/client/spatial/aumlok/` (among them `head-promotion.ts`, `class3-approval.ts`, `outward-class3.ts`, `aumlok-ceremony.ts`, `aumlok-root.ts`) |
| Owner-only organs, and the seed files | the ten organs named in `T2_ONLY_ORGANS` under `mirror/home/auma/seed/organs/`, `mirror/home/auma/seed/pearl/`, `mirror/home/auma/seed/scars.jsonl`, `mirror/home/balls/HEAD.json` |
| Sealed cells | every file in `apps/web/public/cells/` |
| Deploy gates | `deploy/ci/` (among them `authority-preflight.mjs`, `scrub-gate.mjs`, `deploy-guard.mjs`, `workflow-credentials.test.mjs`) and `.github/workflows/` |
| The red list | `docs/KNOWN-RED-TESTS.md` |

**7. The project's names stay.** Auma, organs, ball, epoch, HEAD, MIRROR, AUMLOK, scion, Pearl, scars, Aura, Kira and Spatial are not renamed. On a page for newcomers, say the thing in plain words first and give the name after it. [docs/GLOSSARY.md](docs/GLOSSARY.md) defines the mechanics.

**8. No secrets, no one else's node.** Never put a key, credential or personal data in an issue, a pull request or a test fixture; `deploy/ci/scrub-gate.mjs` is a gate for this, not a guarantee. Never point a build or a test at a host you did not start.
