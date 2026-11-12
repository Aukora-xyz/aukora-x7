---
kind: upgrade-guide
description: "配置好的所有者会话可以授权首次登记，单器官 passkey 提升要求规范 manifest。"
---
# 所有者会话登记与 passkey head 提升

[English](guide.md) | 中文

## 变更

已配置的 Cloudflare 主机在缺少 `AUMLOK_ENROLLMENT_MODE` 时默认使用 `owner-access-genesis-v1`。首次登记要求已认证的所有者会话、验证过的注册和单独的 WebAuthn 断言、节点密钥持有证明、精确来源、未过期状态，以及原子的未绑定且零登记状态。会话现在是既有身份的信任锚：持有有效所有者会话的人可以登记新凭据。这不证明硬件或生物识别。显式 `owner-signature-v1` 保留额外的精确意图签名要求；未知模式被拒绝。

默认双参数 head 构造器支持由所有者 passkey 授权单个治理器官变更，不再要求单独的 Pearl 资格。该路径不会创建资格记录或声称行为测试成功。仅 passkey 路径要求规范的完整 manifest ID、其他兄弟条目不变，并保留哈希、父 head/epoch、writer lease 和原子单次批准检查。普通 Class 1 变更仍需资格；显式提供的资格验证回调仍是强制要求，显式 null/undefined 覆盖会保持该路径关闭。

运行时快照和暂存父 head 读取器接受有效的旧式与规范 ID。新构造的治理候选项使用规范 ID；现有暂存候选项不会被改写。旧运行时 bundle 可能拒绝规范 head，因此部署须同时提供兼容的运行时和 edge 代码。现有 UI 读取器仍可能在服务器拒绝之前，为旧式 ID 或混合兄弟条目变更的候选项提供批准操作；服务器的准入元数据本身并不是客户端预检执行。

Worker `node` 命令保留有界生命周期规则：直接注入的定时器和返回的 Promise 共用 30 秒期限，超时返回非零状态，并清理所拥有的定时器。外部 worker 和模块定时器仍不受跟踪；同步工作无法抢占。

## 迁移

1. 保留托管状态、pepper 和登记记录。不要重置它们来重新登记。部署前审查默认的会话信任策略；如果需要额外的独立签名，应显式使用 `owner-signature-v1`。该模式仍需要生成[验证器](../../../../deploy/cloudflare/src/enrollment-approval.mjs)定义的精确证明。
2. 本地登记还要求 `X6_AUMLOK_ORIGIN`、`X6_OWNER_EMAIL` 和 `X6_OWNER_PUBLIC_KEY_HEX`；`X6_AUMLOK_ENROLLMENT_MODE` 可选。来源须精确匹配允许的回环来源。提供真正签名、audience 为该 host:port 的所有者 JWT。只有本地 capability cookie 不足以登记；本变更不会创建凭据。
3. 提升前加载兼容的运行时，并准备仅改变目标治理条目的规范候选项。显式重新暂存旧式候选项；不要自动修改正在使用的暂存工件。多个治理器官仍需依次分别获得所有者批准。服务器可以在消费批准之前返回 `CLASS3_CANONICAL_MANIFEST_REQUIRED`。
4. 使客户端预检与服务器准入策略一致。测试首次有效绑定仅成功一次、错误或过期会话、伪造或重放批准、格式错误的模块、过期 lease、竞争提交及事务回滚。合成测试成功不代表已完成真实仪式或部署。
5. 在 `node -e` 中为外部工作返回完成 Promise；超时重试之前检查可能仍在继续的工作。分别验证真正加载的版本，不能以 Git 和测试结果替代。
