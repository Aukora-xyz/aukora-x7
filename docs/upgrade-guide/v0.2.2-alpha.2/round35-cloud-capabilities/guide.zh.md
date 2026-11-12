---
kind: upgrade-guide
description: "结果不确定的提供方请求派发现在返回终止错误 HTTP 422，而不是可重试的 HTTP 503。"
---
# 云端提供方未知结果处理

[English](guide.md) | 中文

## 变更

当上游请求派发抛出异常且提供方可能已经处理请求时，Cloudflare `/door/*` 调用方会收到 HTTP 422，而不是 HTTP 503。响应包含 `x-should-retry: false`、`code: PROVIDER_OUTCOME_UNKNOWN`、`outcome: unknown`、`retry: do-not-repeat-automatically` 及 `error.type: provider_outcome_unknown`。已预留配额仍计为已用。Worker 不会重试。

默认 LLM（大语言模型）客户端不再将此响应归类为可重试的服务器故障。显式配置的 `mode: always` 重试策略仍可重复请求。此响应不能证明提供方已拒绝或完成请求，也不提供去重保证。[Cloudflare 宿主参考](../../../../deploy/cloudflare/README.zh.md)负责说明有界仓库访问、所有者批准的发布及可信文档能力。源代码变更不会激活生产环境凭据或部署。

## 迁移

1. 更新自定义 `/door/*` 响应处理程序，使其识别 HTTP 422 及嵌套的 `provider_outcome_unknown` 错误。显示或转发此故障时，保留顶层结果和重试字段。
2. 移除对未知结果的自动重新提交，包括任何适用的 `mode: always` 覆盖配置。在有意提交新请求前，检查提供方侧的证据；缺少响应不能证明请求未执行。
3. 使用实际客户端重试策略运行合成响应丢失场景。确认上游仅收到一次请求、配额仍计为已用，且报告终止性的未知结果。经所有者授权后另行验证线上模型访问及已加载部署；合成模型 ID 兼容性检查不能证明其中任一项。
