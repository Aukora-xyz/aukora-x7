---
kind: upgrade-guide
description: "云端快照消费方必须处理有界且检查修订号的响应流，以及更严格的状态请求验证。"
---
# 检查修订号的云端快照读取

[English](guide.md) | 中文

## 变更

云端快照响应不再占用变更队列直到流传输结束。每个成功完成的快照都来自同一次捕获的 lineage 和修订号。并发变更可能在 HTTP 200 之后以 `MIRROR_SNAPSHOT_CHANGED` 终止响应体；调用方可能遇到流错误或 JSON 解析错误，而非 HTTP 错误响应。系统不为重试保留历史修订版本。

每个 MirrorDO 实例最多允许两个活动快照流，每个流的总期限为 60 秒。额外的完整读取返回 HTTP 503 `MIRROR_SNAPSHOT_BUSY`；精简状态及修订号未变的条件请求仍可使用。已取消或超时的流会继续占用名额，直到任何待处理的存储读取结束。冲突下载保持串行行为。

`/_mirror/status` 仅接受无请求体的 GET，且不得携带查询参数，或只能携带精确的 `?compact=1`。其他方法返回 HTTP 405；不支持或重复的查询参数、片段及非零请求体长度返回 HTTP 400。完整状态保留现有字段。精简状态及无响应体的 HTTP 304 快照响应报告修订元数据，不验证内容。

## 迁移

1. 轻量轮询应在引导初始化完成后请求经过认证的 `GET /_mirror/status?compact=1`。读取 `lineageId`、`revision`、`snapshotFormat` 及 `snapshotETag`；精简状态不包含文件列表或计数。参见[云端镜像传输](../../../../deploy/cloudflare/README.zh.md)。
2. 获取 `/api/snapshot?snapshotFormat=x61-mirror-snapshot/v2`。仅在保留了对应的完整且已验证快照时，才在 `If-None-Match` 中使用返回的强 `ETag`；HTTP 304 没有响应体。使用 `If-Match` 要求已知修订号；陈旧或弱验证器返回 HTTP 412 `MIRROR_SNAPSHOT_PRECONDITION_FAILED`。存在重置记录时仍要求 v2 格式，条件读取也不例外。
3. 在读取整个响应体期间持续实施字节限制和取消机制。不要应用任何不完整快照。发生截断、超时、取消、HTTP 412 或 `MIRROR_SNAPSHOT_BUSY` 时，保留本地待处理工作，并在有界重试策略内重新获取完整快照。持续写入可能使读取无法完成。
4. 激活前，使用隔离的 fixture（测试前置数据）验证完整响应体检查、修订号未变时的 HTTP 304 处理、陈旧验证器拒绝及并发写入取消。源代码变更不能证明已部署或已完成线上验证。
