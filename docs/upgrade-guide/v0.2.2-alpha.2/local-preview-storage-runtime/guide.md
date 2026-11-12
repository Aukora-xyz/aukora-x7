---
kind: upgrade-guide
description: "X6.1 local previews require protected storage migration, explicit runtime selection and bounded repository commits."
---
# X6.1 protected storage and runtime selection

English | [中文](guide.zh.md)

## Change

IndexedDB v2 replaces blind saves with durable revision checks for local-preview browser profiles. Older tabs may lose storage connections during upgrade while unsaved VFS changes remain volatile. Same-profile stale saves are refused, not merged. Stored rows and identity are preserved; the original v1 memory file remains unchanged, while later explicit mutations append v2 records. Private local version copies help contain loss but provide neither cross-profile CAS nor cloud backup.

Main can now use a retained complete static runtime closure instead of mutable build output. Building, capturing and pushing do not select it. Candidates have full live storage and broker access. Selection affects future main boots without reloading existing workers or restoring private state.

`x6_repo` commits now require explicit source paths and a message, and reject existing staging or private/generated paths. The [runtime README](../../../../packages/experimental/webworker-runtime/README.md) owns the guarantees and limitations.

## Migration

1. Before choosing **Continue with protected storage**, save or export pending work from older tabs. Keep those tabs open until unsaved work is explicitly reconciled. Their storage connections may close during migration. If the upgrade blocks or a save reports conflict, preserve volatile work before reloading; no automatic merge occurs.
2. Before rebuilding, run `node server/build-preview.mjs --seal-existing` only for already verified legacy output that lacks `apps/web/dist/preview/asset-seal.json`. Never overwrite an existing completed seal routinely or seal failed/partial output. Build with `pnpm -C apps/web build:preview`. Inspect interrupted producers and locks before clearing anything. Use `node server/build-preview.mjs --rebuild-unsealed` only after inspecting failed output and retained-cache health, and confirming producer termination.
3. On `/recovery/`, choose **Open live candidate**. In that worker, call `ball_status`; inspect `buildIdentity`, `activeFibers`, `fiberHealth` and `persistence`, then exercise the intended behavior. Confirm the expected build, functioning intended fibers, `durable: true`, `readOnly: false` and no conflict before selection.
4. After verification, choose **Review main selection**, then **Select for future main boots**. Open a new `/` tab and confirm `buildIdentity.runtimeReleaseId` matches the selected closure; recheck fibers and persistence. Refresh `/recovery/` to confirm the selected runtime release and runtime epoch. `ball_status.epoch` is the separate organ epoch. Selection acknowledgement alone is not boot evidence.
5. Pass exact safe source-file `paths` and a nonempty `message` to `x6_repo(action: "commit")`. Review the exact diff and existing staging first. Do not reset unrelated staged work to bypass refusal.

If an updated writer reports `MIRROR_QUEUE_FULL`, new changes are not durably saved. Keep that tab open and preserve its unsaved work while existing mirror delivery frees room for a retry. Do not reload it as a capacity fix. `MIRROR_BATCH_TOO_LARGE` needs a smaller explicit change; draining alone cannot resolve it. Existing queued batches remain intact, but browser quota and older clients remain outside the logical admission limit.

Local host HTTP request bodies above 64 MiB now return `413 REQUEST_BODY_TOO_LARGE` before mutation or proxy dispatch. Reduce the explicit payload rather than retrying it unchanged; this also applies to model/fetch proxy requests.
