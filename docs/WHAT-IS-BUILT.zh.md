# 已构建的内容

[English](WHAT-IS-BUILT.md) | 中文

本页是这棵树的清单：Aukora 今天已有的主要机制、承载每个机制的文件、固定它的测试，以及它被证明到了什么程度。它写成可以逐行核对的形式；首页（[README.md](../README.zh.md)）是简短版本，[ARCHITECTURE-MAP.md](ARCHITECTURE-MAP.zh.md) 画出各部分如何配合。

**成熟度标签。** 每一项带有下列标签中的一个或多个，不使用其他标签：

- **IMPLEMENTED**：这棵树中有它的代码和测试。
- **RECORDED RUN**：见 [docs/RUN-RECORD.md](RUN-RECORD.zh.md)，是作者在一台机器上对这棵树按发布原样做的一次运行。那次运行有 5,502 个测试用例：5,399 个通过，90 个失败，其中 89 个列在 [docs/KNOWN-RED-TESTS.md](KNOWN-RED-TESTS.zh.md) 中，另有 1 个由那次运行发现并已加入该清单。下文的“RECORDED RUN 中为绿”指某个测试文件出现在记录的命令之一中，且不在该清单上。90 个失败所在的文件都连同数量列在该清单中，因此这样的文件在那次运行中没有失败用例。运行日志不随附。
- **INDEPENDENTLY VERIFIED**：这棵树中还没有任何内容带有此标签。作者之外没有人记录过对它的一次运行。
- **UNVERIFIED**：已声称或已写出，但这里没有测试固定它，或没有运行显示它。代码可能存在但没有测试执行它，或从未在关键之处运行过（已部署的节点、浏览器、真实的 passkey、真实的模型）。
- **DIRECTION**：一个目标。并未按所述构建。

## 摘要

Aukora 是一个由一个人拥有的个人 AI 节点。它的 AI 名叫 Auma，由称为 organ 的小型可替换模块组成，能够编写、编译、测试并暂存自己的下一个版本。提议者永远不是许可者：修改她自己的裁判、向她的仓库合并，或向 GitHub 发帖，都要等所有者用 passkey 批准那些精确的字节，而做这项检查的是边缘端，不是 Auma。

边缘端是带有两个 Durable Object（它的存储）的 Cloudflare Worker：HEAD 选定运行她的哪个版本，MIRROR 保存她家目录的一份副本。智能体运行在所有者的浏览器中，跑在继承来的 DeepSeek Harness 运行时上，`packages/` 的大部分就是它；Aukora 自己的一层是下文点名的权限、自我修改与恢复代码。这棵树是一个原型，由脚本从一个运行中的私有节点导出，不含该节点的世界（它的数据、密钥、名称和历史）。每个节点都从同一个初始版本开始，即 genesis head。

分量在哪里，按文件列出：

- **一次批准覆盖精确字节，并且只能用一次。** IMPLEMENTED；测试文件在 RECORDED RUN 中为绿。边缘端把每个 passkey 挑战绑定到一个请求的来源、方法、路径和请求体哈希。对于 head 的移动和 GitHub 发帖，它在与该效果自身记录相同的存储事务中消耗这次批准；其他获批请求在效果运行之前由边缘端消耗。`deploy/cloudflare/src/aumlok.mjs`、`deploy/cloudflare/src/head-do.mjs`。
- **一条规则决定什么算失败的证明，一个测试读取源码来守住它。** IMPLEMENTED；在 RECORDED RUN 中为绿。只有经过检查且确实错误的证明才能推动锁定。一个 1,091 行的测试解析所有者身份相关的源码，追踪别名，只要在别处调用了验证器就失败；它的豁免清单是空的。`deploy/cloudflare/src/proof-failure-rule.mjs`。
- **她编译自己的候选版本，父版本再给它们打一次分。** 重新评分是 IMPLEMENTED（`scion-growth.spec.ts`，一个无关用例已知为红）。编译步骤本身没有测试调用它：UNVERIFIED。候选 organ 由 scion（她的 organ 编译器）在一个独立的 worker 中编译，并对照 Pearl 的保留套件运行，Pearl 就是她用来避免破坏已有能力的东西。候选版本自己报告的通过会被忽略。`packages/experimental/webworker-runtime/src/x6/scion.ts`、`mirror/home/auma/seed/organs/seed-pearl.js`。
- **身份、密钥和裁判位于 25 个密封的 Wasm 单元中，Auma 把它们当作工具来调用。** 边缘端一个也不调用：它自己的身份和批准代码是 JavaScript（`deploy/cloudflare/src/aumlok.mjs`）。加载器是 IMPLEMENTED（`wasm-cells.spec.ts`，为绿）。25 个单元中有 24 个以不带源码的二进制文件随附，因此任何单元与某份源码相符都是 UNVERIFIED。每个单元都按大小和 SHA-256 固定（不必运行任何东西就能核对），零导入，并在一个 worker 中按燃料配额运行，该 worker 在 5 秒后被结束。`packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`。
- **所有者有一条回来的路。** IMPLEMENTED；在 RECORDED RUN 中为绿。没有针对真实边缘端的恢复记录。一个救援页面、一个 vault、一个有界归档，以及一个只写入空边缘端的恢复。`deploy/cloudflare/src/rescue-kit.mjs`、`deploy/cloudflare/src/recovery-restore.mjs`。

这棵树中统计的数量：genesis head 中有 26 个 organ，25 个 Wasm 单元共 169 个具名操作，26 个智能体工具，15 个只有所有者的 passkey 才能更改的治理 id，48 个边缘端模块共超过 22,000 行，附 71 个测试文件，应用和浏览器运行时共 152 个 spec 文件，以及超过 3,500 个已编写的测试用例。

状态：测试就在树中，等待运行。其中一些已知为红，每个都连同数量和原因列在 [docs/KNOWN-RED-TESTS.md](KNOWN-RED-TESTS.zh.md) 中。作者在一台机器上对这棵树按发布原样做的一次运行记录在 [docs/RUN-RECORD.md](RUN-RECORD.zh.md) 中：一次离线安装、构建、本地主机的一次启动和 5,502 个测试用例，其中 90 个失败：89 个已知为红，1 个由那次运行发现且仍为红。那次运行还发现了另一个失败，由本仓库的导出造成；导出已被更正，该测试套件再次运行后没有失败。它没有显示已部署的节点，也没有浏览器会话，所以依赖它之前请先自己运行。

## 已构建的内容

本节的一切都是这棵树中的代码，按路径点名，并附上固定它的测试文件（有则列出）。每一项都带有标签。测试文件是按它所断言的内容命名的，并不证明它通过。用例数来自 `grep -cE '^\s*(it|test)(\.each)?\('`，它按写出的样子计数，会漏掉在循环中生成的用例。总数是对 `find <folder> -name '<pattern>' | xargs cat` 运行该 grep 得到的。

这些数字，以及如何重新计数。这些是对树本身的计数，不是对任何运行的计数：

- **Organ：26。** `ls mirror/home/auma/seed/organs | wc -l`。同样的 26 个名称是 `mirror/home/balls/HEAD.json` 的条目。
- **Wasm 单元：25 个，共 169 个具名操作。** `ls apps/web/public/cells/*.wasm | wc -l`。25 个固定值在 `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts` 中，169 个名称在这些固定值的 `ops` 列表中。24 个由 Rust 编译，1 个，即 `aura-focus`，由 WAT 编译。当每个固定值都与其文件相符时，这条命令不输出任何内容：`for f in apps/web/public/cells/*.wasm; do grep -q $(shasum -a 256 $f | cut -c1-64) packages/experimental/webworker-runtime/src/x6/wasm-cells.ts || echo $f; done`。（树中没有 Rust 源码，所以“由 Rust 编译”在这里是 UNVERIFIED。）
- **智能体工具：26。** 在 `packages/experimental/webworker-runtime/src/x6/` 中运行 `grep -cE "^      name: '[a-z_0-9]+'," ball-loader.ts`。按 `wc -l`，该加载器有 7,214 行。
- **治理 id：15。** `server/ball-transition.mjs` 中 `T2_ONLY_ORGANS` 里的名称：genesis head 的十个 organ 和五个 Wasm 单元。
- **边缘端：48 个模块，71 个测试文件。** `ls deploy/cloudflare/src/*.mjs | wc -l`，合计超过 22,000 行。测试文件以 `.test.mjs` 或 `.spec.ts` 结尾，位于 `deploy/cloudflare/src/__tests__/`，合计超过 31,000 行。
- **应用和运行时：62 个和 90 个 spec 文件。** `packages/client/ui-layout/tests/` 中的 `*.spec.*` 文件，以及 `packages/experimental/webworker-runtime/tests/` 下的 `*.spec.ts` 文件。
- **已编写的测试用例：3,539。** 边缘端 1,069，应用 974，运行时 845，`server/` 的 29 个测试文件中 513，`deploy/ci/` 的 9 个测试文件中 138。

### 权限：AUMLOK 与所有者的 passkey

AUMLOK 是身份之门：passkey 注册、所有者登录、设备、七个词（所有者的恢复短语）、邀请和精确字节批准。除非给出更长的路径，代码在 `deploy/cloudflare/src/`，测试在 `deploy/cloudflare/src/__tests__/`。

- **精确字节，只用一次。** IMPLEMENTED；测试文件在 RECORDED RUN 中为绿；没有记录真实的认证器。passkey 对一个随机挑战签名，边缘端把该挑战绑定到一个请求的来源、方法、路径和请求体哈希（`aumlok.mjs` 中的 `aumlokClass3Binding`），所以这次批准只能花在那些字节上。它的有效期为五分钟，只能用一次。对于她的 GitHub 发帖，`head-do.mjs` 中的 `consumeClass3` 在一个存储事务中消耗这次批准并预留请求体哈希。该预留不会自动释放，结果未知时也一样，所以重新加载不会造成重复发帖。账本容纳 4,096 个预留，之后拒绝。测试：`convergence-approval-fencing.test.mjs`（5 个用例）、`cloud-brokers.test.mjs`（29 个用例）。
- **页面请求的是它所展示的字节。** IMPLEMENTED；测试 `packages/client/ui-layout/tests/outward-class3.client.spec.tsx`（3 个用例，jsdom），在 RECORDED RUN 中为绿；没有记录浏览器会话。对于一个已暂存的 GitHub 发帖，页面严格地读取该请求，展示它的全文，在点击时再读一次文件，只有它仍是同一个请求时才请求 passkey。`packages/client/ui-layout/src/client/spatial/aumlok/outward-class3.ts`。
- **用绑定的 passkey 登录，并设有闸门。** IMPLEMENTED；在 RECORDED RUN 中为绿；没有记录所有者登录。会话最长持续 8 小时，并不是一次批准。60 秒内五次签名错误的凭证会把门锁住 300 秒。有一个用例发送 100 个重叠的错误凭证，并断言最多启动五次签名检查。`aumlok.mjs`、`gate-lockout.mjs`、`owner-login-slots.mjs`。测试：`owner-passkey-signin.test.mjs`（31 个用例）、`owner-login-gate.test.mjs`（14 个用例）。
- **失败证明的一条规则，做成结构性的。** IMPLEMENTED；在 RECORDED RUN 中为绿。只有当一个密码学证明经过检查且确实错误时，锁定计数器才会移动。垃圾输入、过期的挑战或库错误从不计数，所以外人无法把所有者锁在门外。在 `proof-failure-rule.mjs` 中，只有 `proofOutcome` 调用验证器，只有 `countFailure` 移动计数器，并且一个结果带有其他模块造不出来的私有标记。passkey 的回答先由项目自己的解析筛查（`webauthn-screen.mjs`），那里的不匹配会被拒绝且不计数。`proof-failure-rule.test.mjs`（11 个用例，1,091 行）用 TypeScript 解析器解析所有者身份相关的源码，追踪重命名和命名空间的导入、别名、解构和 `bind`，只要在别处调用了验证器或写了计数器就失败。有一个用例要求每个调用验证器的边缘端文件都被列为身份代码或非身份代码并附上理由，而未决例外的清单（`OPEN`）是空的。它的六个用例植入已知的绕过规则的办法，例如重命名、解构或绑定的验证器，或通过 `Reflect` 写入的计数器，并断言扫描能抓住每一个。
- **第二台设备的 passkey。** IMPLEMENTED；在 RECORDED RUN 中为绿；没有在真实认证器上运行。一个已注册的 passkey 批准“添加设备”，并得到一个一次性代码：256 个随机比特，只以哈希存储，十分钟有效，输错五次即作废。新电脑注册一个 passkey，但只是加入。在已注册的 passkey 确认该确切密钥之前它无法登录，该密钥以六位数的短语展示。`passkey-devices.mjs`。测试：`passkey-devices.test.mjs`（69 个用例）。
- **七个词。** IMPLEMENTED；测试在 `packages/client/ui-layout/tests/host-facts.client.spec.tsx` 中（它的“AUMLOK phrase”和“AUMLOK root sealed by the seven words”两组），在 RECORDED RUN 中为绿；没有记录仪式。页面用 `crypto.getRandomValues` 抽取七个词，在 11,253,636,424,086 个有效短语上均匀抽取（43.36 比特），并只展示一次。它保留的承诺是 600,000 次迭代的 PBKDF2-SHA256，以节点的公钥作盐。文件头给出了这两个选择的理由。`packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts`。这些词用 AES-256-GCM 封存一个 32 字节的根。节点的 Ed25519 密钥由该根派生，封存的根只在绑定的 passkey 断言之后才被释放。`packages/client/ui-layout/src/client/spatial/aumlok/aumlok-root.ts`。
- **夜间授权。** IMPLEMENTED；在 RECORDED RUN 中为绿；没有记录在已部署节点上使用授权。轻点一次 passkey，她就可以在 12 小时内、12 次使用内、每次使用最多 8 个 organ 的范围内，独自添加或替换普通 organ。治理 id 永远不在覆盖范围内。`night-grant.mjs`、`night-grant.test.mjs`（21 个用例）。
- **她不能更改自己的裁判。** IMPLEMENTED；在 RECORDED RUN 中为绿。该清单本身是 Worker 源码，所以更改它是一次代码部署。`server/deploy-cloudflare.mjs` 不要求 passkey；谁持有部署凭证是 UNVERIFIED。十五个 id 按名称仅限所有者，任何声明自己属于治理的条目也一样。十个是 organ：receipts、Pearl（她的保留套件和奠基教训）、Aura（她的连贯性读数）、prediction、recall、memory、body map、superagent、scion（organ 编译器）和 boot。五个是 Wasm 单元：两个裁判、授权账本、身份和密钥。对其中任何一个的更改，都需要 passkey 作用于精确的候选字节。所有者授权必须带有 Ed25519 和 ML-DSA-65 两个签名。`server/ball-transition.mjs`、`deploy/cloudflare/src/owner-grant-policy.mjs`、`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`。测试：`deploy/ci/authority-preflight.test.mjs`（10 个用例）、`hybrid-envelope.test.mjs`（6 个用例）。

### 有机体：organ、ball、scion 与 Pearl

organ 是她的一个可替换模块；ball 是按哈希列出每个 organ 的清单；epoch 是 ball 的版本号。Organ 在 `mirror/home/auma/seed/organs/`。运行时代码在 `packages/experimental/webworker-runtime/src/x6/`，它的测试在 `packages/experimental/webworker-runtime/tests/x6/`。

- **genesis head。** RECORDED RUN：空跑打印出了它在 epoch 1 的 ball id，本地主机对它作出了应答。断言一个长期运行节点的 head 的测试（`organ-entry-states.spec.ts`，“her real head”）因此已知为红。每个节点都从同一个 head 开始：epoch 1，没有父版本，26 个条目，作者为 `genesis`（`mirror/home/balls/HEAD.json`），带有 Pearl 套件和六个 scar（被记录的失败，各附一条教训）。节点此后长出的东西就是它的世界，`.gitignore` 把它挡在仓库之外。
- **Ball 与 epoch。** IMPLEMENTED；在 RECORDED RUN 中为绿。ball 是一份清单，按每个 organ 代码的 SHA-256 列出它们，它的 id 就是它自己的哈希。新的 head 必须把当前 ball 作为父版本，并且恰好高出一个 epoch。过期的调用方会得到 `REBASE_REQUIRED`。`server/ball-head.mjs`、`deploy/cloudflare/src/head-do.mjs`。测试：`server/ball-manifest.test.mjs`（6 个用例）。
- **她暂存自己的下一个版本。** IMPLEMENTED；在 RECORDED RUN 中为绿；没有记录在已部署节点上的暂存。三个工具为所有者暂存它。`stage_organ_promotion` 更改一个 organ，`stage_organ_set_promotion` 添加一到八个普通 organ。两者都克隆当前的 head，加上一个 epoch，并把候选版本发到 `/_head/stage`。`stage_head_promotion` 把一个治理候选版本写入一个审阅文件交给所有者。它们都不发布也不批准。`ball-loader.ts`。测试：`stage-organ-promotion.spec.ts`（10 个用例）。
- **可撤销的实时自我修改。** `tree_patch` 和 `tree_undo` 是 IMPLEMENTED（由 `head-promotion.spec.ts`，34 个用例，和 `open-tab-adoption.spec.ts`，17 个用例执行；在 RECORDED RUN 中为绿）。`self_apply` 和 `self_undo` 没有测试调用它们：UNVERIFIED。`tree_patch` 在不重新加载页面的情况下，在运行中的智能体里挂载或热替换一个 organ，失败的激活会被回滚。`tree_undo` 把一个 organ 恢复到它之前的版本，并按相反顺序释放它注册过的东西。`self_apply` 把新代码存储并换入，作为一步完成，`self_undo` 撤销最后一次更改。`ball-loader.ts`。
- **scion 与一个自我构建步骤。** UNVERIFIED：树中没有测试调用 `scion.ts` 中的编译器或 organ `seed-cycle.js`；把它们连起来的代码在 `scion-growth.spec.ts` 中有测试。`scion.ts` 最多接收 128 个源文件和 2 MiB，并用固定的离线 esbuild-wasm 在一个独立的 worker 中编译它们。编译不会运行或选定结果。随后 `seed-cycle.js` 写入该 organ，计算它的哈希，安装它，运行它的验收用例，并保留或撤销它。`scion_grow` 工具把两者连起来（`scion-growth.ts`）。
- **Pearl，以及攻击裁判的测试。** IMPLEMENTED；`server/pearl.test.mjs` 在 RECORDED RUN 中为绿。不是已证明的隔离，且是自我证明：已部署的 HEAD 不读取 Pearl 的结果（`deploy/cloudflare/src/head-do.mjs`：已部署的 Durable Object 没有提供 `verifyTransitionQualification`）。Pearl 是她用来避免破坏已有能力的东西：一个保留套件，加上称为 scar 的奠基教训。一个含 17 个用例的保留套件和六个 scar 以种子文件随附（`mirror/home/auma/seed/pearl/retention-suite.v1.json`、`mirror/home/auma/seed/scars.jsonl`）。每个 scar 记录一次失败及其教训。六个中有五个点名了现在守护它们的检查，共 14 个，这 14 个每一个都是该套件的一个用例。`scar-aura-silent-calm` 还没有点名任何检查。`seed-pearl.js` 在一个一次性的试验 worker 中，用整个套件运行一个 organ 的两个构建。在 `scion-growth.spec.ts`（27 个用例，其中一个在已知红清单上）中，一个候选版本试图提交伪造的通过，而父版本忽略 worker 的通过标志并重新给输出评分。另有 `server/pearl.test.mjs`（38 个用例）。
- **Receipts、prediction 与 Aura。** IMPLEMENTED。部分为红：`server/aura.test.mjs` 在 RECORDED RUN 中为绿；`server/receipts.test.mjs` 在那里失败 6 个用例，`server/receipts-policy.test.mjs` 失败 3 个，`server/predict.test.mjs` 失败 6 个，均已列出，原因未调查。`seed-receipts.js` 保存一条哈希链接的收据日志，带有 Ed25519 签名的检查点。`seed-predict.js` 在任何东西改变之前，把对下一次晋升的预测作为收据封存，并且不存储分数：读者根据链重新计算意外程度。`seed-aura.js` 按固定规则计算她的连贯性，它的权限层级始终是 `peripheral-hint`。测试：`server/aura.test.mjs`（16 个用例）、`server/receipts.test.mjs`（10 个用例，6 个在已知红清单上）。
- **25 个密封的 Wasm 单元。** 加载器是 IMPLEMENTED；在 RECORDED RUN 中为绿。25 个单元中有 24 个以不带源码的二进制文件随附。`apps/web/public/cells/` 中的每个文件都在 `wasm-cells.ts` 中按大小、SHA-256 和燃料配额固定。加载器按固定顺序接纳一个单元，并在第一次失败时停下：先查大小，再在私有副本上查哈希，然后读取二进制中的内存限制（一块不共享的 32 位内存，带有声明的上限），这一切都在编译之前。然后它要求零导入和恰好是带计量的导出集合。每次调用都在一个独立的 worker 中、以全新的燃料配额运行，该 worker 在 5,000 毫秒后被结束，并且每次调用之后都会再次检查实时内存。这些单元承载身份、密钥、四个裁判、授权账本、风险、记忆策略、Nostr 签名与加密，以及布局。她用 `x6_cell` 工具调用它们。其中一个单元 skillsmith 把 WAT 文本编译成一个新的带计量单元：`aura-focus.wasm` 就是这样由 `aura-focus.wat` 构建的，并且如果检入的字节不同，`server/aura-focus-cell.build.mjs` 以 1 退出。测试：`wasm-cells.spec.ts`（13 个用例）。
- **26 个工具。** IMPLEMENTED；在 RECORDED RUN 中为绿。对外的工具没有针对已部署的节点运行过：UNVERIFIED。除了暂存和自我修改，加载器还注册了这些工具：自我检查（`x6_capability_index`、`x6_browser_estate`、`auma_snapshot`），通过主机持有的门向外伸展（`x6_repo`、`x6_github`、`x6_cloudflare`、`x6_web_eyes`），同时向最多六个其他模型征求意见（`x6_consult`），最多六个并行的子智能体任务（`x6_swarm`），带验收标准和步数上限的持久愿望（`x6_wish`），以及她的 Nostr 身份（`x6_nostr`）。`ball-loader.ts`。测试：`capability-index.spec.ts`（6 个用例）。
- **没有打开标签页时醒来。** IMPLEMENTED；在 RECORDED RUN 中为绿；在已部署的边缘端上是 UNVERIFIED。一个 Durable Object 闹钟可以唤醒她进行一次有界会话：3 轮、6 次工具调用、15 秒（`deploy/cloudflare/src/head-do.mjs` 中的 `CLOUD_WAKE_LIMITS`）。`deploy/cloudflare/src/cloud-wake-tools.mjs` 增加三个只读的仓库工具，并通过 `deploy/cloudflare/src/cloud-model-door.mjs` 增加一次模型轮次，它自己不写入、不暂存、不晋升、不批准也不发布任何东西。只有在设置恰好为 `WAKE_EXECUTOR_ENABLED=1`（`deploy/cloudflare/README.md`）时，唤醒才运行模型。`deploy/cloudflare/src/__tests__/` 中的测试：`cloud-wake-bounds.test.mjs`（23 个用例）、`cloud-wake-off-switch.test.mjs`（5 个用例）。打开标签页一侧是 `wake-loop.spec.ts`（11 个用例）。

### 边缘端：一个 Worker，HEAD 与 MIRROR

HEAD 是选定运行哪个 ball 的边缘端存储；MIRROR 是保存她家目录一份副本的边缘端存储。除非给出更长的路径，代码在 `deploy/cloudflare/src/`，测试在 `deploy/cloudflare/src/__tests__/`。没有这棵树的部署记录。

- **一个 Worker，两个 Durable Object。** IMPLEMENTED；`head-hardening.test.mjs` 在 RECORDED RUN 中为绿，`worker.spec.ts` 在那里 98 个中失败 5 个（已列出）。`worker.mjs`（2,105 行）检查调用者是谁并进行路由。HEAD（`head-do.mjs`，2,808 行）保存选定的是哪个 ball 以及登录锁定。MIRROR（`mirror-do.mjs`）把她家目录的副本存为有序的更新，并拒绝形似机密的文件名。测试：`head-hardening.test.mjs`（20 个用例）、`worker.spec.ts`（写出的有 96 个用例，运行时是 98 个，因为有些是在循环中生成的；5 个在已知红清单上）。
- **救援页面与 vault。** IMPLEMENTED；在 RECORDED RUN 中为绿。`/rescue` 在不启动她的应用、也不向该浏览器写入的情况下，复制一个浏览器所持有的 Auma。它把副本以按 SHA-256 命名的分片发送到 vault，或保存成一个由 `server/rescue-verify.mjs` 重新哈希的包文件。`rescue-kit.mjs`、`rescue-page.mjs`、`vault.mjs`、`world-budget.mjs`。测试：`rescue-pack.test.mjs`（22 个用例）、`rescue-page.test.mjs`（31 个用例）。
- **有界归档，以及只恢复到空的边缘端。** IMPLEMENTED；在 RECORDED RUN 中为绿；没有记录针对真实边缘端的恢复。`cold-archive.mjs`（2,055 行）把边缘端状态写成绑定到所有者的内容寻址归档，并带有一个在自己的对象名下运行的重建演练。`recovery-restore.mjs` 只写入没有 HEAD 也没有 mirror 的边缘端。运行中的边缘端只做比较。测试：`cold-archive-bounded.test.mjs`（44 个用例）、`recovery-restore.test.mjs`（34 个用例）。
- **模型之门，以及在调用之前写下的日志。** IMPLEMENTED；在 RECORDED RUN 中为绿；没有记录模型调用。模型调用经由七个门、六家供应商，发往同一来源上的 `/door/<provider>/`：`deepseek`、`moonshot`（两个门）、`openrouter`、`openai`、`anthropic` 和 `xai`（`packages/experimental/webworker-runtime/src/model-doors.ts`）。门让主机添加一个只有它持有的密钥。`turn-journal.mjs` 在调用供应商之前，把这一轮和请求的 SHA-256 提交到存储，所以标签页崩溃不会丢失所问的内容。当调用在发出之后失败，`provider-dispatch.mjs` 回答 `PROVIDER_OUTCOME_UNKNOWN` 并附带 `do-not-repeat-automatically`。测试：`provider-dispatch.test.mjs`（17 个用例）、`turn-journal-and-body.test.mjs`（5 个用例）。
- **对外工作的代理。** IMPLEMENTED；在 RECORDED RUN 中为绿；没有记录 GitHub 发帖。她通过 `/_host/repo` 读取仓库，并在名为 `auma/proposal/<name>` 的分支上工作。发布需要 passkey 批准，未知的结果被如实回答为未知。`cloud-brokers.mjs`。测试：`repo-brokers.test.mjs`（43 个用例）。
- **部署闸门。** IMPLEMENTED；`deploy/ci/` 的九个测试文件在 RECORDED RUN 中为绿。`deploy/ci/` 包含一个扫描源码和构建产物的清洗闸门、权限预检、一条关于 head 同步可以提交什么的规则，以及一个固定生产凭证可以出现在工作流何处的测试。九个测试文件，其中有 `deploy/ci/scrub-gate.test.mjs`（25 个用例）。
- **签名的 head 公告，以及一个本地主机。** IMPLEMENTED；在 RECORDED RUN 中为绿。本地主机的启动和引导空跑是 RECORDED RUN。`nostr-anchor.mjs` 发布一个种类为 30078 的 Nostr 事件，由节点密钥签名，说明哪个 ball 和 epoch 是她的 head。该文件自己说明它不是中继。`server/local-host.mjs` 在一台机器上模拟 HEAD 和 mirror，而 `server/cloudflare-bootstrap-cli.mjs` 的空跑从不写入也不连接。测试：`nostr-anchor-door.test.mjs`（26 个用例）、`server/cloudflare-bootstrap.test.mjs`（13 个用例）。

### 应用：Spatial

Spatial 是每一个界面都遵循的那一种工作区设计。代码在 `packages/client/ui-layout/src/client/spatial/` 之下，下文写作 `spatial/`。规格在 `packages/client/ui-layout/tests/`。它们在 jsdom 中运行，jsdom 不做布局。RECORDED RUN 的应用那一行在第二次运行时没有失败；没有记录浏览器会话。

- **一个工作区、三条通道、一个手机布局、一份约定。** IMPLEMENTED；在 RECORDED RUN 中为绿。通道是这套设计对它三栏之一的称呼：线程、打开的应用和菜单。框架在十种具名布局之间切换，在 1023px 及以下一次只显示一条通道（`spatial/stores.ts`、`spatial/SpatialFrame.module.css`）。`scripts/spatial-catalogue.ts` 从组件源码生成 `docs/foundations/SPATIAL-CATALOGUE.md`，当检入的文件过期时它的 spec 失败。测试：`app-frame.client.spec.tsx`（43 个用例）、`spatial-compact.client.spec.tsx`（60 个用例）、`scripts/spatial-catalogue.spec.ts`（7 个用例）。
- **Sovereignty。** IMPLEMENTED；在 RECORDED RUN 中为绿。一个界面显示是什么在治理这个节点：持久性、密钥与信任、收据链、已发布的 Pearl 和唤醒开关。它的批准卡片在请求 passkey 之前，根据字节重建条款（`spatial/aumlok/head-promotion.ts`）。`spatial/portal/SovereigntySurface.tsx`。测试：`sovereignty-durability.client.spec.tsx`（29 个用例）。
- **代码差异与链判定。** IMPLEMENTED；在 RECORDED RUN 中为绿。`spatial/portal/organ-code-diff.ts` 显示运行中的 organ 与已暂存 organ 之间的精确变化。`spatial/portal/receipt-chain-verdict.ts` 检查收据账本是否延伸了最后一个检查点，并回答 `APPEND_ONLY`、`OBSERVATION_CONFLICT` 或 `UNDETERMINED`。测试：`organ-code-diff.client.spec.ts`（15 个用例）、`receipt-chain-verdict.client.spec.ts`（8 个用例）。
- **Identity 与 Work。** IMPLEMENTED；在 RECORDED RUN 中为绿。Identity 保存所有者的密钥卡、设备列表、邀请和 Nostr 身份（`spatial/apps/identity/`）。Work 显示什么已获授权、在运行、被阻塞以及在等待所有者（`spatial/work/WorkSurface.tsx`）。测试：`identity-devices.client.spec.tsx`（20 个用例）、`work-autonomy.client.spec.tsx`（81 个用例）、`host-facts.client.spec.tsx`（110 个用例）。
- **Media 与 Documents。** IMPLEMENTED；在 RECORDED RUN 中为绿。一个只读的驱动器，装着她的捕获内容和文档。一条驱动器规则拒绝形似机密的名称和任何带 `..` 段的路径，并且只在三个文件夹之内打开文件。`spatial/apps/media/drive-rule.ts`。测试：`media-drive.client.spec.tsx`（28 个用例）、`media-drive-rule.client.spec.ts`（12 个用例）。
- **自带应用。** Auma Live：IMPLEMENTED，在 RECORDED RUN 中为绿，没有记录音频会话。Auma Lingwa、Zeta Harp 和 Dakini Code：UNVERIFIED（没有测试）；Dakini Code 是一个由三个文件组成的预构建包，不带源码随附。Auma Live 是语音应用（`apps/web/public/assets/stock-apps/auma-live.html`、`apps/web/public/app/aumalive.js`）。供应商密钥留在主机上，页面得到一个短期有效的通行证（`apps/web/public/app/deepgram-voice.js`）。测试：`auma-live-deepgram-voice.client.spec.ts`（17 个用例）、`auma-live-isolation.client.spec.tsx`（4 个用例）。Auma Lingwa 教她的语言（`apps/web/public/assets/stock-apps/auma-lingwa.html`），在 `apps/web/public/app/auma/canon-v16.json` 中有 84 个旅程日和 948 个词汇条目。Zeta Harp 和 Dakini Code 在同一个 `stock-apps/` 文件夹中。上文统计的文件夹中没有测试执行 Auma Lingwa、Zeta Harp 或 Dakini Code。
- **智能体运行在浏览器 worker 中。** IMPLEMENTED；在 RECORDED RUN 中为绿。`packages/experimental/webworker-runtime/` 在 WebWorker 中挂载一个打包的文件系统，把她的家目录保存到 IndexedDB，并把有序的更新发送到 mirror（`src/storage/idb-persist.ts`）。测试：`tests/storage/memory-vfs.spec.ts`（20 个用例）。

## 自己核对

本文件中没有任何内容要求被人信以为真。它写成这样，是为了让一个人，或替人阅读的 AI，可以核对每一行。

- **从“已构建的内容”中任选一行。** 打开路径，读它的文件头注释。然后打开旁边点名的测试，读它断言了什么。
- **重新计数。** 运行“这些数字”中的计数命令。计数不同就是本文件的错误。
- **运行测试。** 命令在“运行它”中。把任何失败与 [docs/KNOWN-RED-TESTS.md](KNOWN-RED-TESTS.zh.md) 对照。不在该清单上的失败是新情况。
- **这棵树能显示什么，不能显示什么。** 它显示按写出的样子的代码和测试，以及作者在一台机器上的一次运行（[docs/RUN-RECORD.md](RUN-RECORD.zh.md)）。那是一份记录，不是保证：你机器上的一次通过、一个已部署的节点、一次浏览器会话或一个速度，都要由你自己去衡量。
- **继承了什么。** `packages/` 的大部分是继承来的 DeepSeek Harness，建立在 Cordis 之上，Cordis 被 vendored 在 `vendor/` 中。Aukora 自己的代码主要在 `deploy/`、`server/`、`mirror/`、`apps/web/public/` 以及上文点名的 `packages/` 路径中。按行数计的比例见 [docs/SIZE-AND-ORIGIN.md](SIZE-AND-ORIGIN.zh.md)。
- **passkey 规则止于何处。** 这里点名的操作会请求 passkey。对一个普通 organ 的更改需要已签名的所有者会话，而不是 passkey（`server/ball-transition.mjs`）。哈希链不是批准：`docs/START-HERE.md` 说明检查点不是 passkey。

## 这些名称，用平白的话说

[docs/GLOSSARY.md](GLOSSARY.zh.md) 定义了 ball、organ、epoch、receipt、checkpoint、head 以及其余机制。项目名称在这里解释。

- **Auma**：住在节点上的 AI。**Organ**：她的模块，每一个都是一个 Cordis 插件（Cordis 是 `vendor/` 中的插件框架）。**Ball**：一个内容寻址的模块包，由一个整数，即 epoch，标注版本。**HEAD** 与 **MIRROR**：边缘端的两个 Durable Object。HEAD 选定 ball，MIRROR 保存她的家目录。
- **AUMLOK**：身份之门：passkey 注册、所有者登录、设备、七个词、邀请和精确字节批准（`deploy/cloudflare/src/aumlok.mjs`）。
- **Aura**：她的连贯性读数（`mirror/home/auma/seed/organs/seed-aura.js`）。Aura Coherence 界面把每个健康单元都画成 Undetermined，直到有主机向它提供数据（`packages/client/ui-layout/src/client/spatial/aura/model.ts`）。
- **Kira**：五个 Wasm 单元上的名称（`apps/web/public/cells/` 中的 `kira-*.wasm`）。它们固定的操作是：对笔记分类、给召回排序、设定存储权限、跨膜准入，以及签署 Nostr 事件（`wasm-cells.ts` 中的 `ops` 列表）。召回 organ 是 `seed-recall.js`。已有的文档没有进一步定义 Kira。**Aperture** 是一个项目名称，这棵树中还没有代码使用它。
- **Scion**：她所提议的 organ 的编译器。**Pearl**：她用来避免破坏已有能力的东西：候选版本要对照运行的保留套件，以及称为 scar 的奠基教训。**Spatial**：每一个界面都遵循的那一种工作区设计（`docs/foundations/SPATIAL-DESIGN-RULES.md`）。**Auma Lingwa**：她的语言，它的文字和课程在 `apps/web/public/app/auma/` 中。

## 先读这个，再读这个

给不需要代码的人，然后给工程师。请先读每个文件的文件头注释。

1. `mirror/home/auma/seed/scars.jsonl`：六个奠基失败，各附一条教训，以及守护其中五个的检查。
2. [`docs/START-HERE.md`](START-HERE.zh.md) 和 [`docs/GLOSSARY.md`](GLOSSARY.zh.md)：角色、风险和术语。
3. [`docs/KNOWN-RED-TESTS.md`](KNOWN-RED-TESTS.zh.md)：每个已知失败的测试，附原因。
4. `deploy/cloudflare/src/proof-failure-rule.mjs`，然后是 `deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs`：失败规则，以及守住它的扫描。
5. `deploy/cloudflare/src/passkey-devices.mjs` 和 `deploy/cloudflare/src/aumlok.mjs`：第二台设备，精确字节批准。
6. `server/ball-head.mjs`，然后是 `deploy/cloudflare/src/head-do.mjs`：epoch 加一规则，在本地和在边缘端。
7. `mirror/home/auma/seed/organs/seed-cycle.js`、`seed-receipts.js`、`seed-pearl.js`：构建步骤、收据、Pearl。
8. `packages/experimental/webworker-runtime/src/x6/scion.ts` 和 `wasm-cells.ts`：编译器和单元加载器。
9. `deploy/cloudflare/src/rescue-kit.mjs`、`deploy/cloudflare/src/vault.mjs` 和 `deploy/cloudflare/src/cold-archive.mjs`：救援副本、vault 和有界归档。
10. `deploy/cloudflare/README.md`：边缘端的限制和引导驱动程序。

## 这里没有什么，什么没有被证明

- **没有任何节点的世界。** 这棵树不含任何真实节点的收据、记忆、转录、快照、密钥或检查点。本文件不声称任何测得的速度或负载。
- **一次记录的运行，以及它遗漏了什么。** [docs/RUN-RECORD.md](RUN-RECORD.zh.md) 记录了一次安装、构建、本地主机的一次启动，以及“运行它”中的测试命令，在一台机器上。它没有记录对 Cloudflare 的部署、浏览器会话、模型调用和 passkey 仪式。
- **有些测试已知为红。** [docs/KNOWN-RED-TESTS.md](KNOWN-RED-TESTS.zh.md) 列出了每一个，附数量和原因。没有一个被删除、跳过或削弱。该清单包括对 receipt、recall 和 prediction 这几个 organ 的测试，以及那次记录的运行所发现且仍为红的那一个失败。
- **已说明的缺口。** `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` 重现了：把整个已存储的快照回滚，可以重新启用一次已花掉的批准。`seed-pearl.js` 说明它的试验不是已证明的隔离。`scion_grow` 在运行中的 organ 上运行它的验收用例，而不是在隔离中。
- **部署触发器是关闭的。** `.github/workflows/` 中没有一个工作流保留自动触发。原来有的已被注释掉并标为 `[disabled in aukora-x7]`，只剩下手动触发，另有三个可复用的工作流，可以被别的工作流调用。37 个工作流文件中的大多数继承自上游；它们全都是设计，不是一次运行的记录。
- **有些源码不在树中。** 25 个 Wasm 单元中的 24 个、`pentora36.wasm` 和 Dakini Code 包以预构建形式随附，不带源码。见许可证一节。

更多缺口，连同显示每一个的文件，在本页末尾表格的最后一列。

## 运行它

作者在一台机器上的 RECORDED RUN：每一行的结果都在 [docs/RUN-RECORD.md](RUN-RECORD.zh.md) 中，两条 `vitest` 行带 `--maxWorkers=3`。每一行都只运行了一次，除了应用那一行，它在对导出作了更正之后又运行了一次。那是一份记录，不是这些命令在你那里会成功的承诺。

```text
pnpm install --frozen-lockfile
PORT=<a port nothing listens on> node server/build-preview.mjs
pnpm run x6:start
node --test server/*.test.mjs deploy/ci/*.test.mjs deploy/cloudflare/src/__tests__/*.test.mjs
node --test deploy/cloudflare/src/__tests__/worker.spec.ts
pnpm exec vitest run packages/client/ui-layout/tests scripts/spatial-catalogue.spec.ts
pnpm exec vitest run packages/experimental/webworker-runtime/tests
node server/cloudflare-bootstrap-cli.mjs --dry-run
```

- `package.json` 固定了 Node 24.9 或更新版本，以及 pnpm 11.28.5。`pnpm run x6:start` 在 127.0.0.1 上运行 `server/local-host.mjs`，所有者的值来自 `X6_OWNER_EMAIL` 和 `X6_OWNER_PUBLIC_KEY_HEX`。
- **警告：** `node server/build-preview.mjs` 会在替换先前的构建之前和完成时，向 `PORT`（默认 4610）上 `http://127.0.0.1` 的一个主机发送 POST。监听在那里的主机，不论是你的还是任何其他程序，都会被改变。当不应触碰任何运行中的主机时，如上所示把 `PORT` 设为一个没有东西监听的端口。
- **没有 `.git` 的副本，以及离线安装。** 构建用 `git rev-parse HEAD` 读取提交，没有时以 1 退出。改为把 `DSH_CLIENT_COMMIT_HASH` 设为 7 到 40 位十六进制数字的任意值，例如 `0000000`：`scripts/client-build-environment.ts` 用它代替 Git，拒绝任何其他形式，并保留前七位。带 `--offline` 的安装，除了包在存储中之外，还需要注册表元数据已经在 pnpm 缓存中；没有的话，请联网安装。两者都是 RECORDED RUN。
- 不要以 `pnpm run x6:build` 开始：在一个全新的克隆上，据报告它会失败（`UNRESOLVED_ENTRY`），因为它需要 `pnpm run build:lib` 或预览构建产生的 `lib/` 输出。这里是 UNVERIFIED。
- **部署之前编辑占位符。** 从这棵树向一个全新账户做云部署是 UNVERIFIED。节点名、主机、账户 id 和仓库都是占位符：`your-node`、`node.example.invalid`、一个全零的账户 id 和 `your_org_x/your-node`。它们在 `deploy/cloudflare/wrangler.toml` 中，也写进了代码，所以新节点也要在那些地方编辑它们：`server/deploy-cloudflare.mjs` 和 `deploy/cloudflare/src/cloud-brokers.mjs` 中的 Worker 名称，`server/seed-cloudflare.mjs` 中的来源、`server/cloudflare-bootstrap-cli.mjs` 中的来源（它拒绝任何其他 `--url`）以及 `deploy/ci/` 中的四个脚本，还有 `server/deploy-cloudflare.mjs` 和 `cloud-brokers.mjs` 中的仓库。`grep -rlE 'your-node|example\.invalid|your_org_x' server deploy .github` 列出每个含有其中之一的文件。`deploy/cloudflare/README.md` 是指南。有些代码注释引用了一份不在这棵树中的规划文档。
- **部署脚本先问 GitHub。** 除非给出 `--deploy`，`server/deploy-cloudflare.mjs` 只打印它的命令。部署之前，它用 GitHub CLI（`gh`）询问仓库的生产环境是否已经持有 Cloudflare 凭证。如果 `gh` 缺失或无法回答，除非同时给出 `--emergency`，否则它拒绝。
- 给节点一个它自己的私有仓库。head 同步把节点的世界提交到所配置仓库的 `main`，绝不提交到共享的源码仓库。

有一个更短的检查，需要 Node 24.9 或更新版本且不需要安装，即 `node scripts/verify-lite.mjs`，它运行 22 个不需要 npm 包就能加载的测试文件。UNVERIFIED：它不是那次记录的运行的一部分。预期它报告 12 个失败，全部在已知红清单上（`server/memory.test.mjs` 3 个、`server/predict.test.mjs` 6 个、`server/receipts-policy.test.mjs` 3 个），以 0 退出，并以这一行结束：`verify-lite: 22 files, 564 pass, 12 fail, 12 of 12 on the known-red list`，这是在一台机器（Node 24.11.1）上看到的。它不覆盖权限测试（批准只用一次、证明失败规则、仅限所有者的 id、夜间授权、转换分类器、回滚缺口的重现）：这些需要上面的安装。安装之后，`--with-packages` 会加入其中的 16 个；该层级同样是 UNVERIFIED。

## 它要去向何方

DIRECTION。这些都没有按所述构建。完整的路线图，每一部分都带标签，见 [docs/DIRECTION.md](DIRECTION.zh.md)。

- **自我构建，端到端：** 她提议自己的新版本，scion 构建它，她运行它，所有者批准那个精确的更改，然后它才成为运行中的版本。大部分部件已经写好并有测试；编译器（`scion.ts`）和自我构建步骤（`seed-cycle.js`）没有测试调用它们（UNVERIFIED）。在已部署节点上的整个循环没有记录在这棵树中。
- **她更多地进入 Wasm，节点可以在任何地方。** 在这棵树中，organ 是 JavaScript，25 个单元是 Wasm。智能体在浏览器中运行，云端唤醒是有界的，并且除非被打开否则是关闭的（`deploy/cloudflare/README.md`）。
- **一个人类网络：** 节点通过真人的邀请相连，并由签名事件在节点之间承载同一份记录。在这棵树中有邀请和一个签名的 head 公告，没有中继。

## 许可证，以及这棵树不含什么

许可证：GNU Affero General Public License v3.0 or later（`AGPL-3.0-or-later`）。全文是 [LICENSE](../LICENSE)。上游 DeepSeek Harness 是 MIT，它的声明原样保留在 [LICENSES/MIT-DeepSeek-Harness.txt](../LICENSES/MIT-DeepSeek-Harness.txt) 中。第三方声明在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 中。Aukora 与 DeepSeek 没有关联，也没有得到它的认可。

每一个部署值都是占位符，如“运行它”中所列。`mirror/home/auma/seed/organs/seed-receipts.js` 中固定的检查点签名密钥是合成的：该文件说明没有人持有私钥那一半。

源码不在本仓库中的预构建文件：`apps/web/public/cells/` 中的 Wasm 单元，除了 `aura-focus.wasm`（它的源码 `aura-focus.wat` 在这里）；`apps/web/public/seed-library/pentora/` 中的 `pentora36.wasm`；以及 Dakini Code 包。每一处旁边的 `LICENSE.binaries` 都这样说明。单元和 Dakini Code 的说明写明，这些文件处于根目录 AGPL 之下，以及在它们的源码未发布期间会怎样。是否在这里发布这些源码，或声明其他条款，是版权持有者尚未作出的决定。`pentora36.wasm` 不同：本仓库尚未授予它任何许可证，根目录 AGPL 和单元说明都不覆盖它，它的条款由它的版权持有者来声明。

## 主张、源码、测试、证据

每一个主要的架构主张，放在一张表里。“绿”指在 RECORDED RUN 中为绿，如开头所定义。边缘端路径在 `deploy/cloudflare/src/` 之下，边缘端测试在 `deploy/cloudflare/src/__tests__/` 之下，运行时路径在 `packages/experimental/webworker-runtime/src/x6/` 之下，organ 路径在 `mirror/home/auma/seed/organs/` 之下。没有一行是 INDEPENDENTLY VERIFIED。

| 主张 | 源码 | 测试 | 证据 | 标签 |
|---|---|---|---|---|
| 一次批准绑定到一个请求的来源、方法、路径和请求体哈希 | `aumlok.mjs` `aumlokClass3Binding` | `convergence-approval-fencing.test.mjs` | 绿；没有记录真实认证器 | IMPLEMENTED |
| 一次晋升批准绑定到 ball id、epoch、organ 和候选哈希 | `owner-grant-policy.mjs` `headPromotionBinding` | `aumlok-restore-rehearsal.test.mjs` | 绿；该测试中的 passkey 数据是手工构造的 | IMPLEMENTED |
| 一次批准有效 5 分钟，同时最多 8 个有效，并且只用一次 | `aumlok.mjs` `AUMLOK_LIMITS`、`consumeApprovalInTransaction` | `convergence-approval-fencing.test.mjs` | 绿 | IMPLEMENTED |
| 批准在移动 head 的同一个存储事务中被消耗 | `head-do.mjs` `publish` | `head-hardening.test.mjs`（“expired approval rolls back both consumption and HEAD selection”） | 绿 | IMPLEMENTED |
| 一次 GitHub 发帖的请求体哈希被永久预留，4,096 个槽位 | `head-do.mjs` `consumeClass3` | `cloud-brokers.test.mjs` | 绿；没有记录发帖 | IMPLEMENTED |
| 只有经检查且错误的证明才会推动锁定 | `proof-failure-rule.mjs` | `proof-failure-rule.test.mjs` | 绿 | IMPLEMENTED |
| 15 个只有所有者 passkey 才能更改的 id；没有标签能降低它们 | `server/ball-transition.mjs` `T2_ONLY_ORGANS` | `convergence-policy.test.mjs`、`deploy/ci/authority-preflight.test.mjs` | 绿 | IMPLEMENTED |
| 受保护清单只能通过代码部署来更改，而没有 passkey 把关 | `server/ball-transition.mjs` | `deploy/ci/workflow-credentials.test.mjs` 固定部署凭证可以出现在何处 | 谁持有该凭证：没有记录 | UNVERIFIED |
| 26 个 genesis 条目中有 14 个不受保护，其中有 `seed-cycle` | `server/ball-transition.mjs` `isT2OnlyOrgan`、`mirror/home/balls/HEAD.json` | 无 | 从树中数出：表下的命令打印 14 | UNVERIFIED |
| 新的 head 把选定的 ball 作为父版本，并且恰好高出一个 epoch | `server/ball-head.mjs`、`head-do.mjs` `publish` 和 `stage` | `server/ball-manifest.test.mjs`、`head-hardening.test.mjs` | 绿 | IMPLEMENTED |
| 每个模块在发布时重新哈希 | `head-do.mjs`（`MODULE_HASH_MISMATCH`） | `worker.spec.ts` | 在一个有 5 个已知红用例的文件中 | IMPLEMENTED |
| 调用方不能设置它自己的访问头 | `worker.mjs` `forward` | `guest-access-boundary.test.mjs` | 绿 | IMPLEMENTED |
| 夜间授权：12 小时、12 次使用、每次使用 8 个 organ，从不包括治理 | `night-grant.mjs` | `night-grant.test.mjs` | 绿；没有记录在已部署节点上使用授权 | IMPLEMENTED |
| 仅一个所有者会话（最长 8 小时）就可以换掉一个不受保护的 organ 的代码 | `server/ball-transition.mjs` `classifyTransition`、`head-do.mjs` `publish` | `signed-head-actions.test.mjs` | 绿；这是已说明的缺口，不是防御 | IMPLEMENTED |
| scion 在一个独立的 worker 中编译候选版本，最多 128 个文件和 2 MiB | `scion.ts` `createScionCompiler`、`runScionWorker` | 没有测试调用它 | 没有记录 | UNVERIFIED |
| 父版本重新给候选版本的输出评分，并忽略它自己的通过标志 | `scion-growth.ts` `trialScionCandidate` | `scion-growth.spec.ts` | 1 个无关用例已知为红；不是已证明的隔离 | IMPLEMENTED |
| 一个自我构建步骤：安装、在运行中的 organ 上测试，保留或撤销 | `seed-cycle.js` | 没有测试调用它 | 没有记录 | UNVERIFIED |
| Pearl 用整个保留套件运行两个构建 | `seed-pearl.js` `challenge` | `server/pearl.test.mjs` | 绿；自我证明；已部署的 HEAD 不读取它（生产中没有给 `head-do.mjs` 提供 `verifyTransitionQualification`） | IMPLEMENTED |
| 受保护的 organ 为所有者暂存，从不挂载 | `ball-loader.ts` `buildOrganPromotion`、`treePatch` | `stage-organ-promotion.spec.ts`、`head-promotion.spec.ts` | 绿 | IMPLEMENTED |
| 页面根据字节重建条款并显示差异 | `spatial/aumlok/head-promotion.ts`、`spatial/portal/organ-code-diff.ts` | `organ-code-diff.client.spec.ts`、`sovereignty-durability.client.spec.tsx` | 在 jsdom 中为绿；没有记录浏览器会话 | IMPLEMENTED |
| 一个独立的批准显示，使被攻破的页面无法请求所有者没有读过的条款 | 无；[SECURITY.md](../SECURITY.zh.md) 说明了这个缺口 | 无 | 没有记录 | DIRECTION |
| 单元被固定，不导入任何东西，按燃料运行，在一个 5 秒后被结束的 worker 中 | `wasm-cells.ts` | `wasm-cells.spec.ts` | 绿；25 个中有 24 个不带源码随附 | IMPLEMENTED |
| 边缘端的权限决定在 Wasm 中运行 | 无：它们是 JavaScript；没有边缘端模块加载裁判或身份单元 | 无 | 没有记录 | DIRECTION |
| 收据是带有签名检查点的哈希链 | `seed-receipts.js` | `server/receipts.test.mjs` | 部分为红：那次运行中 6 个用例失败（写出了 10 个）；签名密钥是合成的 | IMPLEMENTED |
| 救援副本、vault 和有界归档 | `rescue-kit.mjs`、`vault.mjs`、`cold-archive.mjs` | `rescue-pack.test.mjs`、`rescue-page.test.mjs`、`cold-archive-bounded.test.mjs` | 绿 | IMPLEMENTED |
| 恢复只写入空的边缘端 | `recovery-restore.mjs` | `recovery-restore.test.mjs` | 绿；没有在真实边缘端上恢复 | IMPLEMENTED |
| 恢复整个已存储的快照可以重新启用一次已花掉的批准 | `aumlok.mjs`、`head-do.mjs` | `aumlok-restore-rehearsal.test.mjs`（三个重现；十个 todo 用例，来自两次 `test.todo` 调用，其中一次在对九个缺口的循环中） | 作为缺口的重现为绿；树中没有修复 | IMPLEMENTED |
| 一个模型轮次在调用之前被记入日志，并且从不盲目重试 | `turn-journal.mjs`、`provider-dispatch.mjs`、`worker.mjs` `providerDoor` | `provider-dispatch.test.mjs`、`turn-journal-and-body.test.mjs` | 绿；没有记录模型调用 | IMPLEMENTED |
| 云端唤醒是有界的（3 轮、6 次调用、15 秒），并且默认关闭 | `head-do.mjs` `CLOUD_WAKE_LIMITS`、`cloud-wake-tools.mjs` | `cloud-wake-bounds.test.mjs`、`cloud-wake-off-switch.test.mjs` | 绿；不是在已部署的边缘端上 | IMPLEMENTED |
| 一个签名的 Nostr head 事件；没有中继 | `nostr-anchor.mjs` | `nostr-anchor-door.test.mjs` | 绿 | IMPLEMENTED |
| 中继、她自己的事件日志、节点之间的交换 | 无 | 无 | 没有记录 | DIRECTION |
| genesis head 在本地主机上启动 | `server/local-host.mjs`、`mirror/home/balls/HEAD.json` | `server/local-host-routes.test.mjs` | 启动了一次；在 epoch 1 应答了 genesis ball | RECORDED RUN |
| 从这棵树向一个全新账户的云部署 | `server/cloudflare-bootstrap-cli.mjs`、`server/deploy-cloudflare.mjs` | `server/cloudflare-bootstrap.test.mjs` | 只有空跑 | UNVERIFIED |
| 一次所有者批准的自我修改，端到端，来自这棵树 | 上面的各行 | 没有端到端的测试 | 没有记录 | UNVERIFIED |
| 作者之外的任何人运行过这棵树 | 无 | 无 | 没有记录；没有任何东西是 INDEPENDENTLY VERIFIED | UNVERIFIED |

14 个不受保护的 genesis 条目的计数，从仓库根目录运行（它读取两个文件，不写入任何东西）：

```text
node -e "import('./server/ball-transition.mjs').then(m=>{const h=JSON.parse(require('fs').readFileSync('mirror/home/balls/HEAD.json'));console.log(Object.keys(h.entries).filter(id=>m.isT2OnlyOrgan(id,h.entries[id],h.entries[id])===false).length)})"
```
