---
kind: upgrade-guide
description: "自动唤醒在三次未确认的周期后暂停，并提供不具授权效力的 aura 提示。"
---
# 自动唤醒暂停与 aura 提示

[English](guide.md) | 中文

## 变更

本地与 Cloudflare 唤醒计划此前会持续运行，直到被明确禁用。现在，若操作员未明确恢复，计划在三次自动周期后暂停。状态包含 `consecutiveUnacknowledgedWakes` 和 `autoPaused`；暂停时为 `enabled: false` 且 `nextWakeAt: null`。手动周期不会重置计数。现有存储根据保留的自动回执保守推导计数，因此打开时可能已暂停。

每次周期记录与所选 head 绑定的 `aura:latest` 注意力提示。独立提供的健康输入可通过 `probe_skipped_rest` 跳过探测；输入缺失或无效时产生保守的 `verify` 提示。已提交的紧急提示在现有 `wake:updated` 通知之外增加 `wake.changed`。Aura 不授予权限，也不证明运行时健康。

## 迁移

1. 保留现有唤醒存储。不要删除回执来恢复暂停的计划。检查状态后，通过现有经过身份验证的唤醒配置操作设置 `enabled: true`，有意识地重置计数并恢复。`enabled: false` 仍是停止开关。
2. 更新状态消费者以显示 `autoPaused` 和计数。将 `wake.changed` 视为注意力通知，而非修改状态的许可。继续接受 `wake:updated`。
3. 本地主机集成者在 [server/local-host.mjs](../../../../server/local-host.mjs) 中向 `createLocalMessagesRequestHandler` 传入 `readWake: () => localWake.status()`。若未提供此可选读取器，旧状态响应保持不变。两个状态别名都会拒绝与当前所选 head 不匹配的 aura。
4. 本地主机通过有界且一致的镜像读取以及已捕获的唤醒元数据提供 `readLocalAuraInputs`。若来源缺失、变化、超限、损坏或未经验证，新的状态响应会返回 `status: incomplete` 和空向量。清单中已启用的条目只是声明，不是观测到的器官健康状态。Cloudflare 仍未安装生产指标读取器，两个主机都不会自动安装探测执行器。使用隔离夹具确认：证据不完整时保持未知，三次自动周期会暂停计划，明确启用会重置计数，有效的休息提示会跳过探测且不改变 HEAD。
