# 安全

[English](SECURITY.md) | 中文

Aukora 是实验性的。它没有做过安全审计，不得被当作安全的或可用于生产环境的系统（[SAFETY.zh.md](SAFETY.zh.md)）。这个仓库里还没有任何内容带有 INDEPENDENTLY VERIFIED 标签。

本项目的核心主张很窄：提议修改的程序（Auma，那个 AI）不是许可修改的程序。一个独立的权限方，目前是名为 edge 的 Cloudflare Worker，会在某些操作之前检查所有者的 passkey。如果有报告展示了绕过这项检查的办法，那是本项目能收到的最有价值的报告。

标签：IMPLEMENTED（代码和测试都在本检出中），RECORDED RUN（见 [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md)，一次属于较早的一棵树的运行），INDEPENDENTLY VERIFIED（目前没有任何内容带有此标签），UNVERIFIED（已声称或已写出，但这里没有测试支撑，或没有运行记录显示），DIRECTION（尚未构建）。

下文用到的词。organ 是 Auma 的一个可替换模块。ball 是按哈希列出每个 organ 的清单，genesis head 是第一个 ball，每个节点都从它开始。Pearl 是一套用例，候选 organ 要按它评分。scion 是候选 organ 的编译器。cell 是小型的密封 WebAssembly 模块。七个词是所有者的恢复短语，sealed root 是加密的密钥，要由这组词和 passkey 一起才能释放。night grant 是一次 passkey 批准，它覆盖之后一组有界的普通修改。

## 如何报告

请私下报告。如果本仓库的 **Security** 标签页提供 **Report a vulnerability**（GitHub 的私密漏洞报告），请使用它。这项设置是否开启，从代码树上看不出来。如果该标签页没有提供，不要公开发布细节：开一个 issue，只说明你有一份安全报告，然后等维护者打开私密渠道。不存在其他报告渠道。

一份有用的报告包含：

- 文件和行号，以及它破坏的那条主张（引用本页或 [docs/WHAT-IS-BUILT.zh.md](docs/WHAT-IS-BUILT.zh.md) 中被它反驳的那一行）；
- 攻击者首先需要什么：什么都不需要、一个所有者登录会话、所有者浏览器中一个被攻陷的页面、对 edge 存储的写权限、部署凭据，或其他东西；
- 复现步骤，如果可以，附一个今天就会失败的测试。最好的形式是一个不需要网络的 `node --test` 文件，风格参照 `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` 中的缺口复现；
- 你测试的提交，以及你运行的命令。

请注意：

- 只针对你自己运行的代码和节点进行测试。本项目没有指定任何公开部署的节点；
- 报告中不要包含密钥、凭据和个人数据；
- 在报告被讨论之前，不要公开细节。

本页不设响应时限，也不提供奖励。报告被接受后，修复或缺口的复现会进入仓库，本页也会随之更新。

## 报告最重要的地方

| 领域 | 从这里开始 |
| --- | --- |
| 批准的绑定与单次使用 | `deploy/cloudflare/src/aumlok.mjs`（`aumlokClass3Binding`），`deploy/cloudflare/src/owner-grant-policy.mjs`（`headPromotionBinding`），`deploy/cloudflare/src/head-do.mjs`（`publish`、`stage`） |
| 什么算验证失败，锁定 | `deploy/cloudflare/src/proof-failure-rule.mjs`、`webauthn-screen.mjs`、`gate-lockout.mjs` |
| 哪些修改需要 passkey | `server/ball-transition.mjs`（`T2_ONLY_ORGANS`、`classifyTransition`），`deploy/cloudflare/src/owner-grant-policy.mjs`（`classifyHeadTransition`），`night-grant.mjs`，`organ-set-rule.mjs` |
| 设备、七个词、sealed root | `deploy/cloudflare/src/passkey-devices.mjs`、`packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts`、`aumlok-root.ts` |
| 恢复、重放与回滚 | `deploy/cloudflare/src/recovery-restore.mjs`、`rescue-kit.mjs`、`vault.mjs`、`cold-archive.mjs` |
| 候选代码与密封 cell | `packages/experimental/webworker-runtime/src/x6/scion.ts`、`scion-growth.ts`、`wasm-cells.ts`，`mirror/home/auma/seed/organs/seed-pearl.js` |
| edge 请求与对外动作 | `deploy/cloudflare/src/worker.mjs`、`cloud-brokers.mjs`、`provider-dispatch.mjs`、`public-https-transport.mjs` |
| 部署关卡与凭据 | `deploy/ci/`、`.github/workflows/` |

`packages/` 的大部分是继承来的 DeepSeek Harness 运行时。那里的缺陷一旦波及 Auma、edge 或所有者的数据，就值得在这里报告。

## 本项目不做的安全主张

每一条都指出了代码树在哪里说明它。

1. **没有审计，不可用于生产环境，不是沙箱。** [SAFETY.zh.md](SAFETY.zh.md)。
2. **passkey 不对字节签名。** 认证器签名的是一个随机质询。edge 保存与精确请求的绑定，并在批准被使用时检查它（`aumlok.mjs`）。所有者只能通过发出请求的那个页面看到条款（`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`）。被攻陷的页面可以请求批准所有者没有读过的条款。代码树里没有独立的显示途径。
3. **并非每个修改都需要 passkey。** 有 15 个 id 是仅限所有者的（`server/ball-transition.mjs` 中的 `T2_ONLY_ORGANS`），再加上任何声明自己属于治理的条目。genesis head 中 26 个 organ 里有 14 个不受保护，其中包括自建步骤 `seed-cycle`。在 edge 上，这类 organ 的新代码用所有者登录会话（最长 8 小时）发布，不需要 passkey 批准：T1 级（`server/ball-transition.mjs` 中的 `classifyTransition`，由 `deploy/cloudflare/src/head-do.mjs` 调用；会话时长见 `worker.mjs` 第 1357 行；`deploy/cloudflare/src/__tests__/signed-head-actions.test.mjs` 第 220 行的用例，它还发送了一个已签名的动作和一个写入者租约）。night grant 让一次 passkey 点按覆盖普通 organ 的修改，最长 12 小时，最多 12 次使用，每次最多 8 个 organ（`night-grant.mjs`）。
4. **恢复整个存储快照可以重新启用一个已用掉的批准。** 三个测试复现了这些缺口：整个存储的回滚会重复一次发布，仅身份的回滚会重新启用一个已用掉的批准，时钟回滚加重启会让一个已过期的批准复活（`deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`，位于第 197、212 和 224 行的用例）。十个 todo 用例（建在第 140 到 152 行：九个已命名的缺口和一个正向恢复用例）说明了缺什么。代码树中没有修复。任何能写入 edge 存储的人都能做到这一点；那具体是哪些账户，是 UNVERIFIED。
5. **恢复快照不携带所有者绑定。** 恢复之后，身份从头开始（`aumlok-restore-rehearsal.test.mjs`，第 143 行）。
6. **仅限所有者的名单可以通过一次代码部署改变。** 这个名单是 Worker 源码，没有 passkey 把关部署。谁持有部署凭据是 UNVERIFIED；`deploy/ci/workflow-credentials.test.mjs` 固定了它可以出现在工作流中的位置。
7. **Pearl 不把关已部署的 head。** edge 的 head 存储只把 Pearl 验证器作为一个选项接受（`head-do.mjs` 中的 `createDurableHeadStore`）；在这个代码树里只有测试会提供一个。Pearl 自己的收据写着 `authorityVerified: false` 和 `isolationProved: false`（`seed-pearl.js`）。记录的那次运行（属于较早的一棵树）中，本机宿主回答的是 `PEARL_QUALIFICATION_UNVERIFIABLE`（RECORDED RUN）。
8. **不声称任何隔离。** 试运行的 worker 是“not proven containment”（`seed-pearl.js`，第 7 行）。构建步骤在运行中的 organ 上执行它的验收用例（`mirror/home/auma/seed/organs/seed-cycle.js`）。scion 编译器（`scion.ts`）和 `seed-cycle.js` 没有任何调用它们的测试。
9. **edge 的决策是 JavaScript，不是 Wasm。** `deploy/` 下没有任何东西调用 judge 和 identity 的 cell。25 个 cell 中有 24 个不带源码发布，所以没有人能检查某个 cell 是否与任何源码相符（[docs/OPEN-SOURCE-READINESS.zh.md](docs/OPEN-SOURCE-READINESS.zh.md)）。
10. **签名者信任没有建立。** 两个检查点签名者密钥是合成的；没有人持有私钥那一半（`mirror/home/auma/seed/organs/seed-receipts.js`，第 37 行）。edge 把签名者信任视为未固定，而且一个有效签名不是所有者批准（`deploy/cloudflare/README.md`，第 75 行）。哈希链不是批准。
11. **ball 清单没有签名。** 发布时检查内容哈希和 epoch 加一规则，不检查 Ed25519 清单签名（[docs/ARCHITECTURE-ACTUAL.zh.md](docs/ARCHITECTURE-ACTUAL.zh.md)，第 23 和 45 行）。收据日志并不对每一种类型都强制 epoch 加一（[docs/START-HERE.zh.md](docs/START-HERE.zh.md)，第 43 行）。混合的 Ed25519 与 ML-DSA 签名动作，只有在提供时才会被检查（`head-do.mjs` 中的 `checkSignedAction`）。
12. **不声称任何 edge 的线上行为。** 代码树里没有 edge 在真实 Cloudflare 运行时上的运行记录，而 edge 自己的 README 说，它的存储限制、线上所有者登录、公网地址强制和供应商调用都没有在那里演练过（`deploy/cloudflare/README.md`，第 39、63、129 到 131、141 行）。`selftest` 回答 `ok: true` 并不能证明任何关于凭据的事情（第 93 行）。归档桶上的写入竞争，以及事务里套事务，是 UNVERIFIED（`deploy/cloudflare/src/vault.mjs`，第 12 行；`world-budget.mjs`，第 10 行）。
13. **筛查不是保证。** 对外请求的密钥筛查是纵深防御（`deploy/cloudflare/README.md`，第 137 行）。语音条款检查是一份拒绝清单（第 157 行）。
14. **没有只用词语的登录，也没有守护者恢复。** 解封需要 passkey 和七个词两者（`aumlok.mjs`，第 745 行）。失败十次后，代码回答 `AUMLOK_GUARDIAN_QUORUM_REQUIRED`，而代码树里没有任何代码执行这种恢复。

## 未解决的问题

这些问题已知、尚无答案，对任何人开放。

- 所有者如何能独立于发出请求的页面，看到一次批准的精确条款？（主张 2）
- 什么能堵住整个存储的回滚：外部见证、持久的时钟高水位线，还是所有者恢复 epoch？`aumlok-restore-rehearsal.test.mjs` 中的十个 todo 用例就是验收清单。（主张 4）
- 对普通 organ 的修改，需要的是否应该比 edge 上的所有者会话更多？（主张 3）
- 在真实节点上，谁能写入 edge 的存储，谁持有部署凭据？（主张 4 和 6）
- 一个全新的节点如何获得真正的检查点签名者，又如何更换它们？（主张 10）
- 这 24 个 cell 能否从已发布的源码重建到它们固定的哈希？（主张 9）
- 候选代码能否被隔离，评分能否独立于候选者？（主张 7 和 8）
- edge 在真实运行时上的行为，是否如它的测试所说？（主张 12）从这个代码树到一个全新账户的云部署是 UNVERIFIED。

另见 [docs/KNOWN-RED-TESTS.zh.md](docs/KNOWN-RED-TESTS.zh.md)（`server/receipts.test.mjs` 中的 6 个红色用例和 `server/receipts-policy.test.mjs` 中的 3 个都落在收据链上），以及 [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md)，了解那次记录的运行（属于较早的一棵树）没有覆盖什么。
