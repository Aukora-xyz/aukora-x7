---
kind: upgrade-guide
description: "Round 22 用显式批准和版本化验证替换环境隐含的所有者权限及旧版 AUMLOK 持久化。"
---
# Round 22 安全约定

[English](guide.md) | 中文

## 变更

SOURCE：Worker 持有的所有者签名私钥已由客户端签名的混合授权或绑定通行密钥的显式批准替代。受保护的修改操作要求新的 Class 3 批准。通用混合验证并不等于完整的身份迁移。

以下表述是有适用范围的协议目标，并非无条件保证：「根据协议，仅有短语无法执行操作；在基础设施未被攻破时，离线验证是不可能的；在线猜测受到速率限制并留有审计记录；剩余风险也已明确记录。」

它假定经 pepper 包装的托管内容无法被取得。暴露的客户端 AES-GCM 密文允许离线猜测。公开邀请中的 `inviteeCommitmentSha256` 也可能允许离线猜测。浏览器或存储被攻破、密文被复制，都会破坏这一假定；在线限制无法约束离线攻击。

## 迁移

1. 保留 `aumlok:v1` 存储。[AUMLOK](../../../../deploy/cloudflare/src/aumlok.mjs) 以 `AUMLOK_STATE_MIGRATION_REQUIRED` 拒绝旧版 v1；目前没有迁移工具。切勿通过重置来重新注册。保持 pepper、承诺值和托管内容私有。原始词语会以 `CLASS4_RAW_SECRET_FORBIDDEN` 被拒绝。仪式客户端必须提供 `sealedRootKeyB64`、`kdfSaltB64`、`kdfIterations` 和 `ivB64`。
2. Genesis 要求独立批准精确意图，并验证 Owner Access、注册、断言及节点密钥持有证明；仅有软件认证器的声明并不足够。未安装生产环境批准方。轮换保留节点密钥；解封要求重新验证绑定的通行密钥。限制包括每小时 5 次失败、指数退避和累计 10 次失败；硬锁定没有监护人恢复服务。审计保留最新 256 条记录、累计及已裁剪计数和哈希承诺，并非完整归档或可从外部验证的防篡改证明。读取旧版 v2 状态从不写入；裁剪、时间流逝和成功操作从不重置失败计数。
3. 对受保护的 head 更改、消息及代理修改操作，发送 `x-x6-class3-approval`。单次使用的令牌在批准后五分钟到期，不受 120 秒挑战有效期限制。通用动作绑定来源、代次、方法、路径及完整请求正文摘要；治理使用[晋升绑定](../round23-security-bridge/guide.zh.md)。参见[宿主强制检查](../../../../deploy/cloudflare/src/head-do.mjs)。
4. 使用[混合验证](../../../../deploy/cloudflare/src/owner-grant-policy.mjs)：Ed25519 加 Pure ML-DSA-65，上下文为 `aukora.v2`，域为 `aukora.hybrid.v2\0`，采用规范化的封装字段，且两个签名均不可缺少。固定公钥前，独立核实并解决交接说明与检查点的公钥不一致；封装及镜像不能建立信任。**迁移完成前禁止激活混合签名：**[事实验证](../../../../server/verified-facts.mjs)和 [seed-receipts](../../../../mirror/home/auma/seed/organs/seed-receipts.js) 仅在独立配置的有限区间内允许检查点 15 及之后使用 v1；v2 要求即将退出的密钥的联署签名和可用的混合签名器。下游治理及浏览器授权仍使用 v1；邀请及撤销仍使用 Ed25519 v1。
5. 在两个宿主上配置 `PROVIDER_BUDGET_WINDOW_MS`、`PROVIDER_BUDGET_REQUESTS`、`PROVIDER_BUDGET_TOKENS` 和 `PROVIDER_MAX_OUTPUT_TOKENS`。仍支持有容量限制的内联函数工具；拒绝可能产生隐含费用的请求形式。预留额度不是计费上限。任意公网抓取以 `PUBLIC_NETWORK_GUARD_UNAVAILABLE` 拒绝；保留精确的本地只读探测和固定目标的有界搜索。候选代码执行以 `GATE_CONFINED_RUNNER_REQUIRED` 拒绝；目前没有隔离服务。
6. 使用 [Vite 基线注入](../../../../apps/web/vite.config.ts)执行非 watch 重新构建；保持基线用例及 fixture（测试前置数据）不变。[运行时比较](../../../../packages/experimental/webworker-runtime/src/x6/ball-loader.ts)负责基于不变输入运行候选版本和当前版本，并拒绝 `baselineSpecifier`。使用 `suiteDigest`、`suiteBytesDigest`、`baselineResult`、`comparisonComplete`、`targetImproved` 和 `winnerId`；平局、不完整运行及诊断调用从不获得晋升资格。激活前验证有效及无效 fixture。

UNVERIFIED：源码及测试不能证明已部署行为。未配置生产密钥、公钥固定项、部署或激活。
