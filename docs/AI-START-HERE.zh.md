# AI 从这里开始

[English](AI-START-HERE.md) | 中文

本页写给冷启动阅读这个仓库的 AI：编程智能体、研究智能体或评审者。在你概括、推荐或修改任何东西之前，先读本页。下面的每个路径都在这棵树中。标签在第 5 节定义。

下文用到的词：Auma 是这棵树里的个人 AI；organ 是她的一个可替换模块；ball 是按 SHA-256 列出每个 organ 的清单，它的 epoch 是它的版本号；HEAD 是选出正在运行的 ball 的边缘端存储；边缘端是那个独立的程序，即一个 Cloudflare Worker，负责许可（第 2 节有更多说明）。

## 1. 唯一的规则

提议一个动作的智能，永远不是许可这个动作的权威。Auma 是这棵树里的个人 AI，她可以编写、编译、测试并暂存对她自己的修改。一个独立于她的权威，决定敏感修改是否生效，而今天这个权威就是所有者的 passkey，由一个 Cloudflare 边缘端检查。

今天用什么来强制执行（IMPLEMENTED）：

- **一次批准覆盖精确字节，并且只能用一次。** 边缘端把一次批准绑定到一个请求（来源、方法、路径、请求体的 SHA-256），或绑定到一次晋升（ball、epoch、organ、候选版本哈希）。批准的有效期是 5 分钟。对于 head 的移动，批准在移动 head 的同一个存储事务中被消耗；其他获批的请求，则在效果运行之前、在边缘端被消耗。`deploy/cloudflare/src/aumlok.mjs`（`aumlokClass3Binding`、`consumeApprovalInTransaction`）、`deploy/cloudflare/src/owner-grant-policy.mjs`（`headPromotionBinding`）、`deploy/cloudflare/src/head-do.mjs`。测试：`deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs`、`head-hardening.test.mjs`。
- **只有所有者的 id。** 15 个只有 passkey 才能改动的名称：十个 organ 和五个 Wasm 单元，外加任何声明自己属于治理的条目。`server/ball-transition.mjs` 中的 `T2_ONLY_ORGANS`。测试：`deploy/cloudflare/src/__tests__/convergence-policy.test.mjs`。
- **对失败的证明只有一条规则。** 只有经过检查且确实错误的证明才能推动锁定，所以外人无法用垃圾数据把所有者锁在门外。`deploy/cloudflare/src/proof-failure-rule.mjs`；它的测试解析所有者身份相关的源文件，只要在其中别处调用了验证器或写入了预算就失败：`deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs`。

委托的许可是指所有者交出一个有界的权威切片，绝不是权威本身。有三种形式（IMPLEMENTED）：最长 8 小时的所有者登录会话，它不是批准；夜间授权（night grant），一次 passkey 点按，允许在最多 12 小时、12 次使用、每次使用最多 8 个 organ 的范围内添加或替换普通 organ（`deploy/cloudflare/src/night-grant.mjs`，测试 `night-grant.test.mjs`）；以及一组最多八个普通 organ 的获批集合（`organ-set-rule.mjs`，测试 `organ-set.test.mjs`）。三者都不覆盖只有所有者的 id。

信任模型不完整之处（每一条都是代码今天的工作方式；没有一条已修复）：

- 认证器签名的是一个随机挑战，不是这些字节。边缘端存放这些字节；所有者只能通过页面看到它们（`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`）。被攻陷的页面可能请求所有者没有读过的条款。
- 仅凭所有者会话、没有 passkey 点按，就可以替换一个已有的、未受保护的 organ 的代码（`server/ball-transition.mjs` 中的 `classifyTransition`；测试 `signed-head-actions.test.mjs`）。26 个创世 organ 中有 14 个未受保护，`seed-cycle` 就是其一。
- 只有所有者的列表是 Worker 的源码。修改它是一次代码部署，而没有 passkey 把守部署。谁持有部署凭据：UNVERIFIED。
- 边缘端的决定是 JavaScript。`deploy/` 下没有任何东西调用裁判或身份 Wasm 单元。“每个决定都在 Wasm 中”是 DIRECTION。

## 2. 十行说清这个有机体

1. **organ** 是 Auma 的一个小型可替换模块：一个 JavaScript 文件，作为 Cordis 插件加载（`mirror/home/auma/seed/organs/`，26 个文件）。
2. **ball** 是按 SHA-256 列出每个 organ 的清单；它的 id 就是它自己的哈希。**epoch** 是它的整数版本。
3. **创世 head** 是每个节点的起点：epoch 1、没有父版本、26 个条目（`mirror/home/balls/HEAD.json`）。
4. **HEAD** 是选出当前 ball 的边缘端存储；新的 ball 必须把它指为父版本，并且正好高一个 epoch（否则返回 `REBASE_REQUIRED`）。**MIRROR** 是存放她的 home 副本的边缘端存储。
5. **scion** 是编译她所提议 organ 的编译器：一个固定版本的离线编译器，位于一个独立的 worker 中（`packages/experimental/webworker-runtime/src/x6/scion.ts`）。没有测试直接调用 `compile`：UNVERIFIED。
6. **Pearl** 是用来给候选版本打分的保留套件（17 个用例，`mirror/home/auma/seed/pearl/retention-suite.v1.json`，organ 为 `seed-pearl.js`）。它的 receipt 写着 `authorityVerified: false`；它是自我证明的。
7. **scars** 是六次奠基性的失败，附有教训和把守它们的检查（`mirror/home/auma/seed/scars.jsonl`）。
8. **receipt** 是一条哈希链日志，带有 Ed25519 签名的检查点（`seed-receipts.js`）。receipt 是证据，不是批准。
9. **记忆**：她的 home 保存到 IndexedDB，并同步到 MIRROR（`packages/experimental/webworker-runtime/src/storage/idb-persist.ts`）。回忆和记忆 organ 有红色测试（第 10 节）。
10. **Aura** 是她的连贯性读数，始终是 `peripheral-hint` 层级（`seed-aura.js`）。**Kira** 是五个记忆侧 Wasm 单元（`kira-*.wasm`）上的名称；文档没有进一步定义它。

身份不是模型。Auma 的身份是她的 head、她的 home、她的 receipt 链，以及 AUMLOK 释放给所有者的节点密钥。智能是哪个托管模型通过同源的门 `/door/<provider>/` 作答：六家供应商共七扇门（`packages/experimental/webworker-runtime/src/model-doors.ts`）。换了模型，有机体、它的规则和它的所有者都不变。这棵树中没有记录任何一次模型调用。

真实的运行时：智能体在浏览器的 WebWorker 中运行，建立在继承来的 DeepSeek Harness 运行时之上（`packages/experimental/webworker-runtime/`），organ 由 `ball-loader.ts` 加载。边缘端是一个 Cloudflare Worker（`deploy/cloudflare/src/worker.mjs`），带两个 Durable Object 和一个 R2 存储桶（`deploy/cloudflare/wrangler.toml`）。一个本地 Node 宿主在一台机器上模拟边缘端（`server/local-host.mjs`）。需要 Node 24.9 或更新版本，以及 pnpm 11.28.5；记录的那次安装离线链接了 1,458 个包（RECORDED RUN），而权限测试需要 `@simplewebauthn/server`、`@noble/curves`、`@noble/post-quantum`、`@scure/base` 和 `typescript`。应用界面遵循 **Spatial**，唯一的工作区布局（`packages/client/ui-layout/src/client/spatial/`）。

## 3. 信任架构，以及每一部分的限度

| 部分 | 它是什么 | 文件 | 限度 |
|---|---|---|---|
| AUMLOK | 身份之门：passkey 注册、登录、设备、七个词（所有者的恢复短语，用它封存节点的根密钥）、邀请、精确字节批准 | `deploy/cloudflare/src/aumlok.mjs`、`passkey-devices.mjs` | 没有记录真实的认证器；测试使用手工构造的 passkey 数据。失败十次之后，代码回应 `AUMLOK_GUARDIAN_QUORUM_REQUIRED`；没有找到执行监护人恢复的代码。 |
| Passkey | WebAuthn，要求用户验证 | `webauthn-screen.mjs`、`proof-failure-rule.mjs` | 签名的是一个随机挑战，不是这些字节（第 1 节）。 |
| 精确字节批准 | 绑定到一个请求，5 分钟，只能用一次 | `aumlok.mjs`、`head-do.mjs` | 整个存储的恢复可以让一次已被消耗的批准重新生效（见下）。 |
| 只有所有者的 id | 15 个受保护的名称 | `server/ball-transition.mjs` | 列表是代码；一次部署就能改它。 |
| 边缘端 | Worker、HEAD、MIRROR | `worker.mjs`、`head-do.mjs`、`mirror-do.mjs` | HEAD 不读取 Pearl：在生产中没有传入资格验证器（`head-do.mjs`），而本地宿主在 RECORDED RUN 中回应了 `PEARL_QUALIFICATION_UNVERIFIABLE`。这棵树没有记录在真实 Cloudflare 运行时上的任何运行。 |
| Wasm 单元 | 25 个模块，按大小和 SHA-256 固定，零导入，燃料配额，5 秒 worker | `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`、`apps/web/public/cells/` | 25 个中有 24 个没有源码随附。Auma 通过 `x6_cell` 调用它们。Worker 一个也不调用；本地宿主运行其中一个，`aura-focus`，在 JavaScript 结果旁以影子方式运行，没有任何权威。 |
| 持久化 | 浏览器中的 IndexedDB，向 MIRROR 有序更新 | `idb-persist.ts`、`mirror-do.mjs` | MIRROR 保存当前状态，不保存文件历史（`MEMORY_HISTORY_NOT_IMPLEMENTED`）。 |
| 恢复 | 救援页面、vault、有界归档，只能恢复到空的边缘端 | `rescue-kit.mjs`、`vault.mjs`、`cold-archive.mjs`、`recovery-restore.mjs` | 快照省略了 AUMLOK 绑定，所以身份要重新开始。对真实边缘端的恢复：UNVERIFIED。 |

## 4. 阅读顺序，附以行数计的阅读预算

**约 230 行。** 本页（134），然后是 `docs/RUN-RECORD.md`（54）和 `docs/KNOWN-RED-TESTS.md`（44）。你现在知道了规则、证据和失败之处。

**约 1,470 行。** 加上 `README.md`（150，前页）、`docs/WHAT-IS-BUILT.md`（233：声明、文件、测试、标签）、`docs/ARCHITECTURE-MAP.md`（133）、`docs/GLOSSARY.md`（23）、`server/ball-transition.mjs`（125）、`deploy/cloudflare/src/proof-failure-rule.mjs`（250）、`deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`（232）和 `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs`（88）。

**一整天。** 加上 `deploy/cloudflare/src/aumlok.mjs`（1,806）、`head-do.mjs`（2,808）、`owner-grant-policy.mjs`（353）、`night-grant.mjs`（127）、`deploy/cloudflare/README.md`（167）、`mirror/home/auma/seed/organs/seed-cycle.js`（148）、`seed-pearl.js`（523）、`seed-receipts.js`（501）、`packages/experimental/webworker-runtime/src/x6/scion.ts`（179）、`wasm-cells.ts`（915）、`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`（1,060）、`deploy/cloudflare/src/recovery-restore.mjs`（485），然后是 `docs/DIRECTION.md` 和 `docs/SIZE-AND-ORIGIN.md`。`ball-loader.ts`（7,214）按符号读，不要整个读。

**论证。** `docs/WHITEPAPER.md`（885，只有英文）是本项目的完整论证。它的 Book V 和 Book VI 已对照这棵树核对过：读了代码，没有运行。

不要从 `AGENTS.md` 开始：除了顶部的一个指针，它放的是继承来的 harness 的编码规则，不是本项目的治理规则。它自己的开头仍把读者送到 `docs/START-HERE.md`，那是一个更旧的页面，把代码描述为继承来的运行时，并使用较旧的标签用词；先读本页。不要通过抽样 `packages/` 来了解 Aukora 是什么（第 7 节）。

## 5. 标签约定

| 标签 | 含义 |
|---|---|
| IMPLEMENTED | 代码和测试在这棵树中。不说明这些测试是否通过。 |
| RECORDED RUN | 在 `docs/RUN-RECORD.md` 中展示：一次运行，一台机器，由作者完成。 |
| INDEPENDENTLY VERIFIED | 由作者以外的人运行或检查过。目前没有任何东西带有这个标签。 |
| UNVERIFIED | 已被声称或写出，但这里没有测试守住它，或没有运行展示它。 |
| DIRECTION | 一个目标。尚未建成。 |

当你概括这个项目时，每一条声明都要保留这些标签，并且绝不要把一条声明移到比这棵树所支持的更强的标签上。目标不是功能。较旧的页面（`docs/START-HERE.md`、`docs/ARCHITECTURE-ACTUAL.md`、`docs/RUN-RECORD.md`、`docs/GLOSSARY.md`）使用 SOURCE、RAN、PROPOSED、UNPERFORMED 和 REPORTED RUN；请把 RAN 和 REPORTED RUN 读作 RECORDED RUN，把 PROPOSED 读作 DIRECTION，把 UNPERFORMED 读作 UNVERIFIED，并且只在存在测试的地方把 SOURCE 读作 IMPLEMENTED，否则读作 UNVERIFIED。较旧的页面说“这里”没有记录运行时，指的是在那个页面上；记录在 `docs/RUN-RECORD.md` 中。

## 6. 绝不能混淆的事

`docs/ARCHITECTURE-MAP.md` 把这些画了出来。

1. 模型不是 Auma。模型提供回复；有机体是她的 head、home、receipt 和节点密钥。
2. 提议不是许可。暂存一个 ball 不会移动 HEAD。
3. 登录会话不是批准。只有对绑定字节的 passkey 断言才是。
4. receipt、检查点或哈希链不是批准。它记录；它不许可。
5. Pearl 通过不是边缘端的决定。Pearl 是自我证明的，而已部署的 HEAD 不读取它。
6. 本地挂载不是晋升。一个标签页可以运行边缘端拒绝的 organ；只有 HEAD 选出 ball。
7. 写出来的测试不是通过的测试，记录下来的通过也不是独立的通过。
8. 这棵树中的代码不是已部署的节点，固定版本的 Wasm 二进制不是可检查的源码。

## 7. 代码的每一部分来自哪里

按本项目唯一的统计，由它自己的历史得出，而这段历史并未公开（UNVERIFIED）：这棵树非 vendor 文本行的 10.5%，以及代码行的 12.9%，是 Aukora 自己的。其余都是继承来的。细节和方法：`docs/SIZE-AND-ORIGIN.md`。

- **Aukora 的一层：** `deploy/`（边缘端和部署门禁）、`server/`（本地宿主、ball 规则）、`mirror/`（创世 head 和 organ）、`packages/experimental/webworker-runtime/src/x6/`（loader、scion、单元）、`packages/client/ui-layout/src/client/spatial/`（应用），以及 `apps/web/public/` 的一部分。
- **继承来的 DeepSeek Harness：** `packages/` 的大部分，外加 `python/`、`native/`、`benchmarks/`、`snapshots/`、`.agents/` 和 `.github/workflows/` 的大部分。MIT 声明在 `LICENSES/MIT-DeepSeek-Harness.txt`。Aukora 与 DeepSeek 没有隶属关系。
- **Cordis：** 每个 organ 所运行的插件框架，vendor 在 `vendor/cordis` 中。
- **没有源码的二进制：** `apps/web/public/cells/` 中 25 个 Wasm 单元里的 24 个（这里只有 `aura-focus.wat`）、`pentora36.wasm`（尚未授予许可）、以及 Dakini Code 包（一个预构建的自带应用，三个文件位于 `apps/web/public/assets/stock-apps/dakini-code/assets/`）。每一个旁边的 `LICENSE.binaries` 都这样说明。

## 8. 如何评判一个被提议的修改

逐个提出问题，并说明哪些答案是否定的。

- 它增加的是真实的能力，还是只让原型看起来更好？
- 它是否保持或加强权威边界？让 Auma 持有凭据、批准她自己的修改，或不经 passkey 就触及只有所有者的 id 的修改，无论看起来多有用，都违背本项目。
- 所有者能否检查它、理解它并撤销它？这里的撤销是一个新的 epoch，绝不是更低的 epoch。
- 它是否改善可移植性、连续性或独立验证？
- 它是否减少对某一个模型或某一家供应商的依赖？
- 另一位开发者能否仅凭这棵树复现并扩展它？
- 它服务的是长期架构，还是只服务这个原型？
- 它是否让每个标签保持诚实，并保留项目的名称（Auma、organ、ball、epoch、HEAD、MIRROR、AUMLOK、scion、Pearl、scars、Aura、Kira、Spatial）？

绝不要为了变绿而削弱、跳过或删除测试。红色测试连同原因记录在 `docs/KNOWN-RED-TESTS.md` 中。

## 9. 当有人问“这是真的吗”

重复下面这段，或比它更弱的话：

> Aukora 是一个由个人拥有的 AI（Auma）的原型，她可以暂存对自己模块的修改，而一个独立的 Cloudflare 边缘端会检查所有者的 passkey，并在对她受保护部分的修改生效之前，把这次批准绑定到一次修改的精确字节。passkey 签名的是一个随机挑战，不是这些字节；绑定由边缘端持有。相关的代码和测试都在这棵树中，只是编译器和自建步骤没有测试，但唯一的运行证据是其作者在一台机器上的一次记录的运行：5,502 个测试用例，5,399 个通过，90 个失败，其中 89 个已列在 docs/KNOWN-RED-TESTS.md 中，没有浏览器、没有部署、没有模型调用，也没有 passkey 仪式。这棵树没有记录任何端到端的、经所有者批准的自我修改，部署到全新账户的云端部署是 UNVERIFIED，也没有任何东西是 INDEPENDENTLY VERIFIED。25 个 Wasm 单元中的 24 个和 Dakini Code 包没有源码随附，pentora36.wasm 尚未授予许可，而且恢复整个已存储的快照可能让一次已被消耗的批准重新生效，树中有一个测试复现了这一点。packages/ 的大部分是继承来的 DeepSeek Harness 运行时，插件框架是 vendor/ 中的 Cordis，所以按一个未经验证的统计，Aukora 自己的一层大约占文本的十分之一。

## 10. 已知失败与未决的安全问题

- 失败的测试，附数量和原因：`docs/KNOWN-RED-TESTS.md`。receipt、回忆、记忆和预测 organ 都在其中。
- 那次运行及其没有覆盖的内容：`docs/RUN-RECORD.md`。
- 整个存储恢复的缺口，已复现，旁边有十个 todo 用例（九个已点名的缺口和一个正向恢复用例）：`deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`。
- 一个无需安装的检查：`node scripts/verify-lite.mjs`，22 个测试文件。它的最后一行，在一台机器上所见（UNVERIFIED）：`verify-lite: 22 files, 564 pass, 12 fail, 12 of 12 on the known-red list`。它不运行权限测试。
- 边缘端自己声明的限度：`deploy/cloudflare/README.md`。
- 按文件和行号列出的缺口、重建和许可的阻碍：`docs/OPEN-SOURCE-READINESS.md`。
- 如何报告漏洞：`SECURITY.md`。没有做过安全审计：`SAFETY.md`。
- 从哪里开始贡献：`docs/GOOD-FIRST-CONTRIBUTIONS.md`、`CONTRIBUTING.md`。计划：`docs/DIRECTION.md`。
