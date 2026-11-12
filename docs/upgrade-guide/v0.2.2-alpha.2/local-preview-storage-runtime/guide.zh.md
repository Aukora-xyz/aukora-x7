---
kind: upgrade-guide
description: "X6.1 本地预览要求迁移受保护存储、显式选择运行时，并限定仓库提交路径。"
---
# X6.1 受保护存储与运行时选择

[English](guide.md) | 中文

## 变更

IndexedDB v2 为本地预览的浏览器配置文件引入持久修订检查，替代不检查修订的保存。升级时，旧标签页的存储连接可能关闭，而尚未保存的虚拟文件系统（VFS）变更仍只是易失状态。同一配置文件内的陈旧保存会被拒绝，不会合并。已存储的行和身份会保留；原始 v1 记忆文件保持不变，后续显式变更则追加 v2 记录。私有本地版本副本有助于控制丢失范围，但不提供跨配置文件 CAS 或云备份。

Main 现在可以使用已保留的完整静态运行时闭包，而不再依赖可变构建输出。构建、捕获和推送都不会选择该闭包。候选运行时具有完整的实时存储和 broker 访问权限。选择只影响此后 main 的启动，不会重载现有 worker 或恢复私有状态。

`x6_repo` 提交现在必须提供明确的源码路径和消息，并拒绝已有暂存内容或私有／生成路径。具体保证和限制由[运行时 README](../../../../packages/experimental/webworker-runtime/README.zh.md)说明。

## 迁移

1. 选择 **Continue with protected storage** 前，先在旧标签页保存或导出待处理工作。在尚未保存的工作完成显式协调之前，保持这些标签页打开。迁移期间，它们的存储连接可能关闭。如果升级受阻或保存报告冲突，请先保留易失工作，再重载；系统不会自动合并。
2. 重新构建前，只有已经验证的旧输出缺少 `apps/web/dist/preview/asset-seal.json` 时，才运行 `node server/build-preview.mjs --seal-existing`。切勿例行覆盖已有的完整构建封存记录，也不要封存失败或不完整的输出。使用 `pnpm -C apps/web build:preview` 构建。清除任何内容前，先检查中断的构建进程和锁。只有在检查失败输出、保留缓存的健康状态并确认构建进程已终止后，才能使用 `node server/build-preview.mjs --rebuild-unsealed`。
3. 在 `/recovery/` 选择 **Open live candidate**。在该 worker 中调用 `ball_status`，检查 `buildIdentity`、`activeFibers`、`fiberHealth` 和 `persistence`，然后实际使用预期行为。选择前，确认构建身份符合预期、所需 fiber 正常运行、`durable: true`、`readOnly: false`，且没有冲突。
4. 验证后，选择 **Review main selection**，再选择 **Select for future main boots**。新开一个 `/` 标签页，确认 `buildIdentity.runtimeReleaseId` 与所选闭包一致，并重新检查 fiber 和持久化。刷新 `/recovery/`，确认所选运行时发布和运行时 epoch。`ball_status.epoch` 是独立的 organ epoch。选择确认本身不能证明 worker 已启动。
5. 向 `x6_repo(action: "commit")` 提供精确、安全的源码文件 `paths` 和非空 `message`。先审查精确 diff 和已有暂存内容。不要通过重置无关暂存工作来绕过拒绝。

如果更新后的写入方报告 `MIRROR_QUEUE_FULL`，新增变更尚未持久保存。应保持该标签页打开并保留其未保存工作，等待已有镜像投递腾出空间后重试。不要把重载当作容量修复。`MIRROR_BATCH_TOO_LARGE` 需要较小的显式变更，仅投递已有批次无法解决。已有队列批次保持完整，但浏览器配额和旧客户端仍不受该逻辑接纳上限保证。

本地 host 的 HTTP 请求体超过 64 MiB 时，现在会在变更或代理发送前返回 `413 REQUEST_BODY_TOO_LARGE`。应减少显式载荷，而不是原样重试；该上限也适用于模型／fetch 代理请求。
