---
kind: upgrade-guide
description: "运行时修改需要独立批准或由构建固定的资格证明；云端发布、身份验证流程和历史写入执行更严格的请求限制。"
---
# 第 21 轮代理授权

[English](guide.md) | 中文

## 变更

运行时和宿主客户端必须处理拒绝响应；此前，修改请求可能在没有独立资格证明的情况下到达执行器。身份验证、浏览器布尔值、承诺值和记录中的成功结果都不是所有者批准。读取和相同 HEAD 的幂等发布仍然可用。这些源代码约定不能证明已经部署或在线启用。

云端代理提供有界、经所有者身份验证的同源读取。GitHub 访问固定为该仓库的 `main` 分支。每次 `write`、`commit` 或 `push` 都是原子发布，不是暂存操作。AUMLOK 要求经过验证的 WebAuthn 注册、随后的断言、独立的 Ed25519 节点密钥持有证明，以及可信的注册批准。浏览器集成和在线验证流程尚未验证；缺少可信批准方时，默认情况下注册不可用。

本地代理保留元数据状态查询和有界、不跟随链接的源代码读取。仓库的 `log`/`diff` 返回 HTTP 503 `LOCAL_REPO_READ_UNAVAILABLE`；GitHub GET API 返回 HTTP 503 `LOCAL_GITHUB_READ_UNAVAILABLE`。通用 shell/`gh`/Wrangler 命令、推送和无资格证明的源代码写入被拒绝。云端仓库的 `log`/`diff` 仍然可用。

具名运行时操作的检查不能约束任意 JavaScript、原始文件系统访问或全局 `fetch`。

## 迁移

1. 按照[代理实现](../../../../deploy/cloudflare/src/cloud-brokers.mjs)使用 `/_host/repo`、`/_host/github` 和 `/_host/cloudflare`。将 `GITHUB_TOKEN` 和 `CLOUDFLARE_API_TOKEN` 保留在服务器端。发布只接受显式指定的 `mirror/home/auma/seed/organs/*.js` 文件、`expectedHeadSha`、`idempotencyKey` 和提交消息。为精确的规范化请求接入独立可信的 `approveRepoPublication`；生产代码未安装此回调。GitHub GraphQL 的 `expectedHeadOid` 会阻止 HEAD 已移动的发布。结果未知时，先用相同请求核对结果，再修改请求。
2. 将客户端更新为 [AUMLOK 的两步验证流程](../../../../deploy/cloudflare/src/aumlok.mjs)。可信进程配置必须提供 `authorizeEnrollment`；任何请求标志都不能启用它。不要在请求中传入原始词组或生物识别数据。用户验证和 `verifyAumlokInviteReceipt` 都不能证明生物识别身份、词组恢复能力、当前邀请资格或兑换状态。
3. 构建[运行时](../../../../packages/experimental/webworker-runtime/src/x6/ball-loader.ts)时，注入由[测试集摘要辅助函数](../../../../packages/experimental/webworker-runtime/src/x6/scion-growth.ts)计算的不可变 `__X6_BUILD_IDENTITY__.retentionSuiteDigest`。当前构建器省略此字段，因此晋升资格仍然不可用。为精确的候选项、配置项、HEAD 和测试集获取新的单次资格证明，并在五分钟内使用。[HeadDO](../../../../deploy/cloudflare/src/head-do.mjs) 和[本地宿主](../../../../server/local-host.mjs)缺少可信的转换资格签发器；新的发布、本地恢复写入和 `POST /_head/runtime` 选择操作仍被拒绝；运行时 `GET` 仍然可用。创建快照需要所有声明模块和历史模块经过验证的字节；这不表示持久备份已确认。
4. 在 `/dsh/home/auma/` 下，保留 `seed/receipts.v3.jsonl` 和 `seed/checkpoints.v1.jsonl` 已有内容的精确前缀，并保留 `memory/dag/` 中已有的内容寻址文件；[MirrorDO](../../../../deploy/cloudflare/src/mirror-do.mjs) 会拒绝改写或删除历史。通过 `checkpointSignerPolicy` 独立提供检查点信任配置，使用从一开始、有限且连续的 `firstSeq`–`lastSeq` 范围。不要同时提供 `checkpointSignerPin`，也不要信任 VFS 提供的密钥。没有独立配置时，签名者仍处于未固定状态。
5. 将[事实](../../../../server/verified-facts.mjs)中的 `organSourceEvidence: recorded-build-info` 视为记录的元数据，而不是正在运行代码的证明。保留未知值；邀请签名辅助函数不是汇总资格检查。启用之前，部署负责人必须使用隔离样例验证缺少批准方时的拒绝、对过期绑定的拒绝，以及保留数据未被改动，然后另行验证部署的构建。
