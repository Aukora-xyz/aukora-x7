# x6_exec: your hands

`x6_exec` runs a command you write on a real Linux machine and lets you watch it: start it, read its state and its log,
cancel it, list your runs and their artifacts. Each run is a fresh GitHub-hosted runner, thrown away afterwards.

## What it is

- A machine with Node 24, pnpm, Python 3, git, `gh` (not signed in), `jq` and `rg` (installed at the start of each run;
  if the package index cannot be reached, the run says so in a warning and goes on without it). Your repository is checked out at
  `ref` (main, or one of your branches `auma/sandbox/<slug>` or `auma/proposal/<slug>`) and its dependencies are
  installed (`pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`). The command runs with
  `bash -eo pipefail` in the repository root.
- It runs as `auma`, an ordinary user made for the run with no sudo, on her own copy of the checkout
  (`/home/auma/repo`). Nothing can be installed system-wide. Her environment is only `PATH`, `HOME`, `LANG`, `CI`,
  `ARTIFACTS` and, with a browser, `X61_PLAYWRIGHT_DIR` and `PLAYWRIGHT_BROWSERS_PATH`. Every process of hers is stopped
  when the command ends, before her artifacts are collected; only plain files and folders under `$ARTIFACTS` are kept
  (links are dropped).
- **Two body users (since 2026-11-16).** The runner also makes `body_a` and `body_b`: no sudo, no group but their own.
  You may start a process as either, and as nobody else: `sudo -n -u body_a "$(command -v node)" lab/x/body.mjs`. Give the
  full path of the program: a body gets sudo's own short PATH, not yours. Each body has a folder
  `/home/auma/bodies/body_a` (and `body_b`) that it and you may read and write and the other body may not read; a
  body cannot read the other's processes, pipes or files. A body CAN read anything of yours that is world-readable,
  which is your whole checkout by default: put a gate's own files in a folder you `chmod 700`. Their processes are
  stopped with yours at the end. This is for fixtures that must show one process losing a right another holds;
  it gives you no new right over the runner, the repository or main.
- `browser: true` adds headless Chromium for the pinned Playwright (1.61.1); its folder is in `X61_PLAYWRIGHT_DIR`.
- `$ARTIFACTS` is a folder whose files are kept for 3 days as the run's artifact `auma-exec-artifacts`.
- After the command, the log always shows `AUMA_EXIT_CODE=<n>`, `git status --short` and `git diff --stat`.

## What it is not

- It holds no secret and cannot change GitHub: the workflow has `contents: read` only, and the checkout keeps no
  credential. main cannot be moved from there.
- What a command changes does **not** come back by itself. Print the diff (`git diff`), read it from the log, and
  bring it home with `x6_repo` `apply_patch` (below). A merge is still the owner's passkey on your card.
- It is not instant: a run takes one to three minutes to start, then up to `timeoutMinutes` (1 to 30, default 10).
  Runs on the same branch wait for each other, first in, first out (one at a time per branch; GitHub keeps up to 100
  waiting).
- Artifacts are not downloaded through the door: `artifacts` names them, sizes and expiry; they are on the run's page.

## How to call it

| Call | What happens |
|---|---|
| `{ action: "run", command, ref?, timeoutMinutes?, browser?, label? }` | Starts `.github/workflows/auma-exec.yml` on main with your inputs. A label you give (1 to 55 characters) gets `-` and 8 hex added, so every run's label is its own; with none, `x-` plus 8 hex is made. It looks for the run a few times; answers `{ ok, run, label, status, url }`, or `{ ok, pending: true, label }` when GitHub has not shown it yet. Keep the full `label` it answers. |
| `{ action: "status", run }` or `{ action: "status", label }` | The run's state and conclusion (by id: its jobs too). By label: give the full label `run` answered. |
| `{ action: "logs", run, job? }` | The newest 252 KiB of the job's log, read from a log of up to 32 MiB (a longer one is refused, `BROKER_BODY_TOO_LARGE`); `truncated` and `earlier` say when the earlier part is only on the run's page. GitHub keeps a job's log only once the job has finished: a queued or running run of yours answers `EXEC_LOG_NOT_READY` with its `status` (and, while it runs, `currentStep`, `stepsDone`, `stepsTotal`), never `BROKER_NOT_FOUND`; ask again when `status` says completed. For bulky output, write it to a file under `$ARTIFACTS` and print its last lines with `tail`. |
| `{ action: "cancel", run }` | Asks GitHub to cancel it (`EXEC_RUN_NOT_CANCELLABLE` when it already finished). |
| `{ action: "list" }` | Your newest 20 runs: id, status, conclusion, created, run name, label, ref, url. |
| `{ action: "artifacts", run }` | Names, sizes and expiry of the run's artifacts. |

From voice: `list`, `status` and `artifacts` only. `run` and `cancel` change things, and `logs` reads a second host.

## Bounds and refusals

- HEAD reserves the requested timeout before dispatch: **600 runner minutes per UTC day** across owner sessions and Worker restarts. No automatic refund on cancellation or an uncertain dispatch. Over it, `EXEC_RATE_LIMITED` includes `retryAt` at UTC midnight. Reads and cancel do not charge it.

- 60 dispatch attempts an hour and 300 a UTC day per owner session, including attempts refused because HEAD is unavailable.
  This throttle is separate from the durable minute budget. A restarted or second edge instance starts its session counts from zero.
  Over it: `EXEC_RATE_LIMITED` with `retryAt` (ms since 1970) and `limit`. An uncertain reservation or dispatch is not automatically retried.
- The command is at most 4,096 characters; for more, put a script on your branch and call it.
- Refusal codes, decided before anything is sent: `EXEC_REF_INVALID`, `EXEC_COMMAND_INVALID`, `EXEC_TIMEOUT_INVALID`,
  `EXEC_BROWSER_INVALID`, `EXEC_LABEL_INVALID`, `EXEC_INPUTS_INVALID`, `EXEC_FIELD_UNKNOWN`. A command that carries
  something shaped like a credential is refused (`BROKER_PRIVATE_CONTENT_REFUSED`); a label or ref shaped like one is
  refused as `EXEC_LABEL_INVALID` or `EXEC_REF_INVALID`. In `list`, a run whose name looks like a credential answers
  `runNameWithheld: true` with no name. On reads: `EXEC_RUN_NOT_FOUND`
  (not a run of `auma-exec.yml`), `EXEC_JOB_NOT_FOUND`, `EXEC_RUN_INVALID`. Without an owner session:
  `OWNER_SESSION_REQUIRED`.

## Three calls to copy

**(a) One runtime spec on your branch.**

```json
{ "action": "run", "ref": "auma/proposal/my-fix", "label": "spec-self-check",
  "command": "./node_modules/.bin/vitest run --maxWorkers=2 packages/experimental/webworker-runtime/tests/x6/self-check.spec.ts" }
```

It answers the full label, for example `spec-self-check-1a2b3c4d`: then `{ "action": "status", "label":
"spec-self-check-1a2b3c4d" }` (that label, never the bare `spec-self-check`) until it is `completed`, and
`{ "action": "logs", "run": <id> }`.

**(b) A small script, and its output.**

```json
{ "action": "run", "label": "py-count",
  "command": "python3 -c 'import json,subprocess; files=subprocess.check_output([\"git\",\"ls-files\"],text=True).splitlines(); print(json.dumps({\"files\":len(files)}))' | tee \"$ARTIFACTS/count.json\"" }
```

The printed line is in the log; `count.json` is in the run's artifact.

**(c) Your app in a headless browser.** Build the preview the way the proposal gate does, then load it with the worked
script `docs/auma/exec/browser-check.mjs` (serves `apps/web/dist` on 127.0.0.1, writes `$ARTIFACTS/app.png`, prints
console errors and failed requests, exits 1 on a console error):

```json
{ "action": "run", "browser": true, "timeoutMinutes": 30, "label": "app-look",
  "command": "PORT=4619 NODE_OPTIONS=--max-old-space-size=5632 node server/build-preview.mjs && node docs/auma/exec/browser-check.mjs" }
```

`PORT=4619` keeps the build's closing notice on a port nothing listens to on the runner.

## Bringing a change home

The runner holds no credential, so a change made there (a formatter, a generator, a fix found while testing) comes back
through one call of yours, inside the same fence every commit of yours passes:

1. Run the change in a job on your branch, and end the command with `git rev-parse HEAD && git diff` (or write the
   diff to `$ARTIFACTS/change.diff` and `cat` it). The printed commit is the branch head the diff was made against.
2. Read the diff from the job log (`x6_exec` `logs`). Take it exactly as printed, from `diff --git` to its last line.
   GitHub's log may put a time and one space before every line (`2026-11-14T02:43:22.1234567Z `): remove exactly that
   prefix and nothing else (a context line keeps its own leading space).
3. Call `x6_repo` with `{ action: "apply_patch", branch, baseSha, patch, message }`: `baseSha` is that head, `patch` the
   diff, `message` one line. The answer is `{ ok, branch, head, files: [{ path, status }] }`: one commit on your branch.
4. Run the tests in a second job on the new `head`.

Rules: at most 256 KiB and 64 files; text only. Every hunk must apply at its stated line with every context and removed
line equal (no fuzz). New, changed and deleted files, CRLF and "no newline at end of file" are kept exactly. A rename,
copy, mode change, binary patch or submodule is refused. Content edits to already-executable files are also refused, named `executable`; the door does not pretend the mode changed. Each path passes the same open and frozen path rules as
`commit`, the new content the same screen for anything shaped like a credential. Never `main`: only
`auma/sandbox/<slug>` or `auma/proposal/<slug>`. No passkey, exactly like `commit` on your branch.

A diff larger than the log tail you can read must be split: run `git diff -- <some paths>` per job and apply each
piece, each against the head the previous one returned.

Refusals (nothing is written): `PATCH_SHAPE`, `PATCH_PARSE` (`line`: the patch line), `PATCH_UNSUPPORTED` (`path`,
`what`: rename, copy, mode, binary, submodule, executable), `PATCH_TOO_LARGE`, `PATCH_FILES_LIMIT`, `PATCH_CONTEXT_MISMATCH`
(`path`, `hunk`; hunk 0: the file exists when the patch adds it, or is missing when it changes it), `REPO_HEAD_MOVED`
(`headSha`: your branch moved; read it again and make the diff on the new head), and every refusal `commit` has.

## Where it lives

- Workflow: `.github/workflows/auma-exec.yml` (held by `deploy/ci/auma-exec-workflow.test.mjs`: dispatch only,
  `contents: read`, no secret, no input inside a script, the same input bounds as the edge).
- Edge: `deploy/cloudflare/src/cloud-brokers.mjs` `execDoor` (tests: `deploy/cloudflare/src/__tests__/auma-exec-door.test.mjs`).
- Your tool: `packages/experimental/webworker-runtime/src/x6/exec-tool.ts` (tests: `tests/x6/exec-tool.spec.ts`).
- Bringing a change home: `cloud-brokers.mjs` `applyPatch` (tests: `deploy/cloudflare/src/__tests__/repo-apply-patch.test.mjs`)
  and `x6_repo` `apply_patch` in `ball-loader.ts` (tests: `tests/x6/repo-apply-patch.spec.ts`).
