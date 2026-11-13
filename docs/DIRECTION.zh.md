# 方向

[English](DIRECTION.md) | 中文

这个项目打算走向哪里，以及各个部分今天走到了哪一步。每一条关于代码的陈述都会指出本仓库中的一个文件。每一条关于不在本仓库中的事物的陈述，都带有 DIRECTION 标签。

本页使用的标签，仅此几种：

- **IMPLEMENTED**：代码和测试在这棵树中。
- **RECORDED RUN**：在 [RUN-RECORD.zh.md](RUN-RECORD.zh.md) 中有记录。
- **INDEPENDENTLY VERIFIED**：由作者之外的人运行过。目前还没有任何一项带有这个标签。
- **UNVERIFIED**：有人声称或写过，但这里没有测试支持，也没有运行记录显示。
- **DIRECTION**：尚未构建。

## 为什么需要它

今天，大多数人是向公司租用 AI。公司决定 AI 可以做什么、记住什么、何时改变。

AI 智能体开始替人行事：在电脑、手机、网络上，在企业里，以后还会在可穿戴设备和机器上。它们做得越多，谁来决定允许它们做什么就越重要。

这个项目的回答是写进结构里的一条规则：提议一个动作的部分，永远不是许可这个动作的部分。AI 可以学习、构建、替换自己的部件，也可以与其他 AI 合作。但它不应获得推翻所有者的权利。

**Auma** 是建立在这条规则之上的个人 AI。她由称为 **organ** 的小型可替换模块组成。她可以编写、编译、测试并暂存新的 organ。她的连续性、权限、身份、记忆、证据和恢复，都应当留在所有者的规则之下；下面的第 2 阶段说明哪些部分已经构建、哪些没有。由一个独立的权威来执行这些规则。今天这个权威是边缘端：一个 Cloudflare Worker，它检查所有者的 passkey（手机和笔记本电脑内置的指纹、面部或安全密钥登录），并把这次批准绑定到一个请求的精确字节的哈希上（`deploy/cloudflare/src/aumlok.mjs`、`deploy/cloudflare/src/head-do.mjs`；测试 `deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs`、`head-hardening.test.mjs`）。IMPLEMENTED。没有针对真实 passkey 的运行记录：UNVERIFIED。

模型会变。工具、硬件和供应商会变。所有者的控制权不应取决于其中任何一个。

## 这个基础想要成为什么

全部是 DIRECTION：一个由一个人拥有的持久环境。它随所有者成长，并跟着所有者跨设备。其他开发者和其他 AI 可以检查它、fork 它、扩展它，也可以运行他们自己的。它是一个基础，不是一个封闭的产品。

## 今天的进展

- 作者在一台机器上做了一次记录的运行：5,502 个测试用例，5,399 个通过，90 个失败，其中 89 个列在 [KNOWN-RED-TESTS.zh.md](KNOWN-RED-TESTS.zh.md) 中。RECORDED RUN。这次运行没有浏览器、没有部署、没有模型调用，也没有 passkey。
- 本树中没有记录过端到端的、经所有者批准的自我修改。UNVERIFIED。
- 从本树部署到一个全新的账户：UNVERIFIED。
- 恢复一份完整的已存快照，可能让一个已经用掉的批准重新生效。有一个测试复现了这一点，并把缺失的防御列为未解决项（`deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`）。树中没有修复。
- 25 个 Wasm 单元（小型的、封存的 WebAssembly 模块）中有 24 个，以及 Dakini Code 包（一个预构建的现成应用，三个文件），都以二进制形式发布，不附源代码（`apps/web/public/cells/LICENSE.binaries`、`apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries`）。`apps/web/public/seed-library/pentora/pentora36.wasm` 发布时尚未授予任何许可。
- `packages/` 的大部分是继承来的 DeepSeek Harness 运行时。插件框架是 Cordis，位于 `vendor/`。见 [SIZE-AND-ORIGIN.zh.md](SIZE-AND-ORIGIN.zh.md)。

完整清单在 [WHAT-IS-BUILT.zh.md](WHAT-IS-BUILT.zh.md)。一次自我修改从头到尾的过程，在 [ARCHITECTURE-MAP.zh.md](ARCHITECTURE-MAP.zh.md) 中一步一步地讲。

## 各个阶段

共六个阶段。每个阶段说明它指什么、树中有什么在支撑它、缺什么，以及“完成”在陌生人眼里是什么样、可以由他们自己检查。这些阶段相互重叠。顺序是依赖的顺序，不是时间表。不承诺任何日期。

### 1. 基础：一个可理解、可复现、归所有者控制的个人节点

**含义。** 一个人可以读懂这个节点如何工作，可以重新构建它、运行它，并且是唯一能批准它敏感修改的人。

**今天有什么在支撑。**
- 精确字节的批准。所有者的 passkey 批准一个请求；边缘端把这次批准绑定到这些字节的哈希，只消耗一次，并在同一个存储步骤中移动当前版本（`deploy/cloudflare/src/aumlok.mjs`、`head-do.mjs`；测试 `convergence-approval-fencing.test.mjs`、`convergence-policy.test.mjs`、`head-hardening.test.mjs`）。IMPLEMENTED。
- 受保护 organ 的清单，只有 passkey 才能改动它们（`server/ball-transition.mjs`；测试 `deploy/cloudflare/src/__tests__/convergence-policy.test.mjs`）。IMPLEMENTED。
- 一个在单台机器上运行节点的本机宿主（`server/local-host.mjs`）。RECORDED RUN：一次启动，未登录，没有浏览器。
- 一个包含 22 个测试文件的免安装检查：`node scripts/verify-lite.mjs`。它不覆盖权威方面的测试，那些需要安装。见 [WHAT-IS-BUILT.zh.md](WHAT-IS-BUILT.zh.md)。

**缺少什么。** 24 个单元的源代码。一个调用编译器（`packages/experimental/webworker-runtime/src/x6/scion.ts`）或自建步骤（`mirror/home/auma/seed/organs/seed-cycle.js`）的测试。一次有记录的部署。一次使用真实 passkey 的、有记录的浏览器会话。在第二台机器上对比过的构建。部署用的值是代码内部的占位符，不只是在 `deploy/cloudflare/wrangler.toml` 里。受保护清单是源代码，所以一次代码部署不用 passkey 就能改掉它。谁持有部署凭据：UNVERIFIED。认证器签署的是一个随机挑战，不是这些字节；所有者只能通过页面看到这些字节。

**完成的样子。** 作者之外的某个人在自己的机器上照着文档操作，部署到一个全新的账户，登记一个 passkey，批准一次修改，并按 [RUN-RECORD.zh.md](RUN-RECORD.zh.md) 的格式发布一份运行记录。那将是第一个 INDEPENDENTLY VERIFIED 的条目。

### 2. 连续性：经得起变化的身份、记忆、收据与恢复

**含义。** 所有者可以更换模型、设备和 organ，而不丢失 Auma 是谁、她记得什么、她做过什么，也不丢失所有者的控制权。

**今天有什么在支撑。**
- organ 列在一个 **ball** 里：一份清单，用 SHA-256 哈希点名每一个 organ。每个 ball 有一个 **epoch**，即版本号，必须恰好加一。**HEAD** 是选出当前 ball 的边缘存储（`mirror/home/balls/HEAD.json`、`deploy/cloudflare/src/head-do.mjs`；测试 `head-hardening.test.mjs`）。IMPLEMENTED。
- **MIRROR** 是保存她主目录文件副本的边缘存储（`deploy/cloudflare/src/mirror-do.mjs`、`packages/experimental/webworker-runtime/src/storage/idb-persist.ts`；测试 `server/mirror-replay.test.mjs`）。IMPLEMENTED。
- 收据：带签名检查点的哈希链日志（`mirror/home/auma/seed/organs/seed-receipts.js`）。IMPLEMENTED，但 `server/receipts.test.mjs` 在 RECORDED RUN 中有 6 个用例失败。边缘端检查这条链（`server/verified-facts.mjs`；测试 `server/verified-facts.test.mjs`）。IMPLEMENTED。
- 记忆 organ（`mirror/home/auma/seed/organs/` 中的 `seed-memory.js`、`seed-recall.js`、`auma-memory-domain.js`）。IMPLEMENTED；它们的测试在 RECORDED RUN 中有失败（`server/recall.test.mjs` 50 个、`memory.test.mjs` 3 个、`absence.test.mjs` 9 个），原因未调查。**Kira** 是五个记忆一侧的 Wasm 单元的名字（`apps/web/public/cells/kira-*.wasm`）。没有 organ 调用它们：作为记忆是 UNVERIFIED。
- 救援页面、保险库、有界归档，以及恢复到一个空的边缘端（`deploy/cloudflare/src/rescue-kit.mjs`、`vault.mjs`、`cold-archive.mjs`、`recovery-restore.mjs`；测试 `rescue-pack.test.mjs`、`vault.test.mjs`、`cold-archive-bounded.test.mjs`、`recovery-restore.test.mjs`）。IMPLEMENTED。针对真实边缘端的恢复：UNVERIFIED。
- 第二台设备：一个已登记的 passkey 批准新设备（`deploy/cloudflare/src/passkey-devices.mjs`；测试 `passkey-devices.test.mjs`）。IMPLEMENTED。真实的认证器：UNVERIFIED。

**缺少什么。** 对整份快照恢复缺陷的修复。真实的检查点签名者（钉住的密钥是合成的）。过去文件版本的边缘端历史（`mirror-do.mjs` 回答 `MEMORY_HISTORY_NOT_IMPLEMENTED`）。十次失败尝试之后的监护人恢复：代码要求它，但没有找到执行它的代码。只凭恢复词在新浏览器上登录：放行需要 passkey 和恢复词两者（`aumlok.mjs`，“there is no passkey-only release”）。DIRECTION。

**完成的样子。** 在一个已部署的节点上：清空浏览器，从救援包恢复，并表明身份、记忆和收据链都回来了，而且没有任何已用掉的批准能再次使用。树中有一个测试支撑其中每一项，并有一份运行记录显示它。

### 3. 可扩展性：别人的 organ、别的实现、别的模型

**含义。** 其他人可以编写 organ、用不同方式实现权威、更换模型或供应商，而所有者的控制权不变。

**今天有什么在支撑。**
- 一个 organ 是一个 Cordis 插件条目，在 ball 里按哈希命名。一组获批的集合里最多可以添加八个普通 organ（`deploy/cloudflare/src/organ-set-rule.mjs`；测试 `organ-set.test.mjs`）。作为一种机制是 IMPLEMENTED。
- 模型之门：在六家供应商前面的同源路径，由宿主加上它持有的密钥（`packages/experimental/webworker-runtime/src/model-doors.ts`；测试 `packages/experimental/webworker-runtime/tests/model-doors.spec.ts`）。一个回合在调用之前先写入日志，结果未知时不会重试（`deploy/cloudflare/src/turn-journal.mjs`、`provider-dispatch.mjs`；测试 `provider-dispatch.test.mjs`、`turn-journal-and-body.test.mjs`）。IMPLEMENTED。没有对真实供应商的调用记录。
- **Pearl** 是一套留存套件，候选 organ 要按它评分（`mirror/home/auma/seed/organs/seed-pearl.js`；测试 `server/pearl.test.mjs`）。IMPLEMENTED。文件自己说它的试运行是“not proven containment”。

**缺少什么。** organ 的作者身份、注册表、签名分发。外来 organ 被隔离的证明。本地模型之门。这些门的表是源代码中的一个固定清单。权威的第二个独立实现。DIRECTION。

**完成的样子。** 项目之外的某个人写的一个 organ，通过所有者的批准安装到一个已部署的节点上，并有一个公开发布的测试表明它无法触及受保护的 organ 或批准存储。第二个实现通过同样的权威测试。

### 4. 互操作：签名事件、她自己的日志、可迁移的状态

**含义。** Auma 所做的事被写成 Nostr 格式的签名事件。她把它们本地保存为自己的日志，并可以与独立拥有的节点交换。她的状态可以在宿主之间迁移。

**今天有什么在支撑。**
- 一条 Nostr 格式的签名 head 公告。文件自己说它不是中继（`deploy/cloudflare/src/nostr-anchor.mjs`、organ `seed-nostr-anchor.js`；测试 `nostr-anchor-door.test.mjs`）。IMPLEMENTED。
- 带可选签名的本地消息；中继列表为空（`deploy/cloudflare/src/messages-store.mjs`；测试 `server/messages-store.test.mjs`）。IMPLEMENTED。
- `nostr-core` 单元（`apps/web/public/cells/nostr-core.wasm`）中有钉住的签名操作，树中没有源代码。只是作为二进制 IMPLEMENTED；它是否与任何源代码一致是 UNVERIFIED。

**缺少什么。** 一个中继客户端。节点之间的事件交换。她完整的日志以签名事件的形式存在。除 Cloudflare 之外的宿主：边缘端代码使用 Durable Objects、R2 和一个 Worker，在内存中的替身上测试过。`aura-relay` 单元有钉住的操作，没有源代码、没有测试、也没有调用方：UNVERIFIED。DIRECTION。

**完成的样子。** 两个属于不同所有者的节点通过一个中继交换签名事件。每一方都能验证对方的事件，而无需信任任何第三方。有一个测试和一份运行记录显示这一点。

### 5. 扩展：语音、手机、可穿戴设备、机器人

**含义。** 无论 Auma 在哪里行动，同样的所有者规则都成立。

**今天有什么在支撑。**
- 一个语音应用 Auma Live，通过一个托管的语音服务，宿主用一个短期有效的通行证代理它（`apps/web/public/assets/stock-apps/auma-live.html`；测试 `deploy/cloudflare/src/__tests__/speech-pass.test.mjs`、`packages/client/ui-layout/tests/auma-live-isolation.client.spec.tsx`）。一个语音导演让语音无法批准任何事（`deploy/cloudflare/src/voice-director.mjs`；测试 `voice-director-hardening.test.mjs`）。IMPLEMENTED。没有音频会话的记录。
- **Spatial** 的手机布局，Spatial 是这个应用唯一的工作区布局（`packages/client/ui-layout/tests/spatial-compact.client.spec.tsx`）。IMPLEMENTED。
- 一个自托管的语音渲染器有描述，也有网关单元测试，但没有镜像构建或 GPU 运行的记录（`deploy/personaplex/README.md`）。UNVERIFIED。

**缺少什么。** 可穿戴设备和机器人：没有代码。DIRECTION。

**完成的样子。** 一句口头请求走到一个敏感动作，并停在那里，直到 passkey 批准，由一个测试和一次有记录的会话显示。

### 6. 生态：没有中央权威、彼此协作的自有节点

**含义。** 许多人运行自己的节点。这些节点互相发现、互相信任，而不需要某个中央方授予身份。

**今天有什么在支撑。** 签名邀请（`deploy/cloudflare/src/aumlok.mjs`；测试 `aumlok-invites.test.mjs`、`guest-redeem-door.test.mjs`）。IMPLEMENTED。边缘端页面写着 “An invite grants no access today”（`deploy/cloudflare/src/worker.mjs`）。

**缺少什么。** 命名、对等发现、多租户托管、节点之间的信任。树中没有代码。DIRECTION。

**完成的样子。** 彼此不认识的人依据公开文档搭建起各自独立拥有的节点，交换签名事件并互相授予有限的访问，而且没有任何账户或密钥由这个项目持有。

## 什么会改变我们的想法

下面这些发现会迫使我们重新设计，而不是打补丁。每一项都会被记录为一条 **scar**：一次奠基性的失败，连同它的教训一起写下来；目前六条中的五条还附有防范它的检查（`mirror/home/auma/seed/scars.jsonl`）。

- **所有者看不到自己批准的是什么。** 如果没有任何独立于页面的显示能展示精确的字节，一个被攻破的页面就可以请求所有者从未读过的条款。批准模型将需要另一种可信的显示。
- **存储回滚无法被隔离。** 如果一个已用掉的批准总能被能写边缘端存储的人复活，那么权威就是存储的持有者，而不是 passkey。`aumlok-restore-rehearsal.test.mjs` 今天复现了这一点。
- **部署路径比 passkey 的权限更高。** 受保护清单是代码。如果一次代码部署无法被置于所有者的批准之下，那么 passkey 守住的就比看上去的少。
- **不受保护的 organ 能触及受保护的权力。** 单凭一个所有者会话，就能改动一个普通 organ，包括自建步骤 `seed-cycle.js`。如果能证明某个普通 organ 可以升级权限，那么普通 organ 与受保护 organ 的划分就是错的。
- **试运行无法被限制在范围内。** 如果一个候选 organ 的试运行始终无法被隔离，自我修改就必须离开所有者的节点，在一个可丢弃的地方运行。
- **决策无法被做到可检查。** 如果这些单元的源代码无法发布或重新构建，这些单元就必须被替换或移除。
- **所有者不再阅读。** 如果所有者不读就批准，passkey 就只是一种仪式，而不是控制。两种情况都是 UNVERIFIED：没有做过研究。

## 它不是什么

- 不是聊天机器人。聊天只是所有者运行的节点的一个界面。
- 不是智能体框架。重点是提议的与许可的之间的那条线。
- 不安全，也不能用于生产。没有做过安全审计（[SAFETY.zh.md](../SAFETY.zh.md)）。
- 没有完成。本页描述的大部分内容都是 DIRECTION。

## 你可以怎样推进它

最有用的单个行动，是第 1 阶段中的那次独立运行。其他起点在 [GOOD-FIRST-CONTRIBUTIONS.zh.md](GOOD-FIRST-CONTRIBUTIONS.zh.md) 和 [CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md) 中。阅读这个仓库的 AI 应当从 [AI-START-HERE.zh.md](AI-START-HERE.zh.md) 开始。术语在 [GLOSSARY.zh.md](GLOSSARY.zh.md) 中定义。

## 成功意味着什么

成功不是人人都运行某一家公司的 Auma。成功是独立的人能够构建、检查、扩展、替换并运行他们自己的 Auma，并在这样做的同时保有有意义的控制。
