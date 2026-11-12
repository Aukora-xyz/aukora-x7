# Aukora

[English](README.md) | 中文

Aukora 是一个由一个人拥有的个人 AI 节点。它的 AI 名叫 Auma，由称为 organ 的小型可替换模块组成，能够编写、编译、测试并暂存自己的下一个版本。提议者永远不是许可者：修改她自己的裁判、向她的仓库合并，或向 GitHub 发帖，都要等所有者用 passkey 批准这些精确字节；做这项检查的是边缘端，不是 Auma。

边缘端是带有两个 Durable Object（它的存储）的 Cloudflare Worker。智能体运行在所有者的浏览器中，跑在继承来的 DeepSeek Harness 运行时上，`packages/` 的大部分就是它；Aukora 自己的一层是下文点名的权限、自我修改与恢复代码。这棵树是一个原型，由脚本从一个正在运行的私有节点导出，不含那个节点的世界（它的数据、密钥、名称和历史）。每个节点都从同一个创世 head 开始。

分量在哪里，按文件列出：

- **一次批准覆盖精确字节，并且只能用一次。** 边缘端把每个 passkey 挑战绑定到一个请求的来源、方法、路径和请求体哈希，并在预留该请求体哈希的同一个存储事务中消耗这次批准。`deploy/cloudflare/src/aumlok.mjs`、`deploy/cloudflare/src/head-do.mjs`。
- **一条规则决定什么算失败的证明，一个测试读取源码来守住它。** 只有经过检查且确实错误的证明才能推动锁定。一个 1,091 行的测试解析所有者身份相关的源码，追踪别名，只要在别处调用了验证器就失败；它的豁免清单是空的。`deploy/cloudflare/src/proof-failure-rule.mjs`。
- **她编译自己的候选版本，父版本再给它们打一次分。** 候选 organ 在一个独立的 worker 中编译，并对照一个保留套件运行。候选版本自己报告的通过会被忽略。`packages/experimental/webworker-runtime/src/x6/scion.ts`、 `mirror/home/auma/seed/organs/seed-pearl.js`。
- **身份、密钥和裁判位于 25 个密封的 Wasm 单元中。** 每个单元都按大小和 SHA-256 固定（不必运行任何东西就能核对），零导入，并在一个 worker 中按燃料配额运行，该 worker 在 5 秒后被结束。`packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`。
- **所有者有一条回来的路。** 一个救援页面、一个 vault、一个有界归档，以及一个只写入空边缘端的恢复。 `deploy/cloudflare/src/rescue-kit.mjs`、`deploy/cloudflare/src/recovery-restore.mjs`。

在这棵树中清点所得：创世 head 中有 26 个 organ；25 个 Wasm 单元，共 169 个具名操作；26 个智能体工具；15 个只有所有者的 passkey 才能改动的治理 id；48 个边缘端模块，总计超过 22,000 行，配有 71 个测试文件；应用与浏览器运行时共 152 个 spec 文件；已写成的测试用例超过 3,500 个。

状态：测试都在树中，等你运行。有些已知为红，每一个连同数量和原因都列在 [docs/KNOWN-RED-TESTS.zh.md](docs/KNOWN-RED-TESTS.zh.md) 中。作者在一台机器上对按原样发布的这棵树做过一次运行，记录在 [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md) 中：离线安装、构建、启动本地宿主，以及 5,502 个测试用例，其中 90 个失败：89 个是已知为红的，1 个是那次运行新发现的、至今仍为红。那次运行还发现了一个由本仓库的导出造成的失败；导出已经更正，那个套件重新运行时没有失败。它没有展示已部署的节点，也没有浏览器会话，所以在依赖它之前请先运行它。下文使用的标签：RAN（在那次记录的运行中完成）、SOURCE（在代码中读到，并附路径）、UNVERIFIED（此处未检查）、DIRECTION （目标）。

## 已经建成的部分

本节的一切都是 SOURCE：这棵树中的代码，按路径点名，有测试文件固定它的地方也点出该测试文件。测试文件按它断言的内容命名，不能当作它通过的证明。用例数量来自 `grep -cE '^\s*(it|test)(\.each)?\('`，它统计写出来的用例，会漏掉在循环中生成的用例。总数就是对 `find <folder> -name '<pattern>' | xargs cat` 运行这条 grep。

这些数字，以及如何重新清点：

- **Organ：26 个。** `ls mirror/home/auma/seed/organs | wc -l`。同样的 26 个名称就是 `mirror/home/balls/HEAD.json` 的条目。
- **Wasm 单元：25 个，共 169 个具名操作。** `ls apps/web/public/cells/*.wasm | wc -l`。25 个固定值在 `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts` 中，169 个名称在这些固定值的 `ops` 列表里。其中 24 个由 Rust 编译，一个（`aura-focus`）由 WAT 编译。每个固定值都与其文件相符时，下面这条命令什么也不输出： `for f in apps/web/public/cells/*.wasm; do grep -q $(shasum -a 256 $f | cut -c1-64) packages/experimental/webworker-runtime/src/x6/wasm-cells.ts || echo $f; done`。
- **智能体工具：26 个。** 在 `packages/experimental/webworker-runtime/src/x6/` 中运行 `grep -cE "^      name: '[a-z_0-9]+'," ball-loader.ts`。按 `wc -l` 统计，加载器有 7,214 行。
- **治理 id：15 个。** 即 `server/ball-transition.mjs` 中 `T2_ONLY_ORGANS` 里的名称：创世 head 的十个 organ 和五个 Wasm 单元。
- **边缘端：48 个模块，71 个测试文件。** `ls deploy/cloudflare/src/*.mjs | wc -l`，总计超过 22,000 行。测试文件位于 `deploy/cloudflare/src/__tests__/`，以 `.test.mjs` 或 `.spec.ts` 结尾，总计超过 31,000 行。
- **应用与运行时：62 个和 90 个 spec 文件。** 即 `packages/client/ui-layout/tests/` 中的 `*.spec.*` 文件，以及 `packages/experimental/webworker-runtime/tests/` 下的 `*.spec.ts` 文件。
- **已写成的测试用例：3,539 个。** 边缘端 1,069 个，应用 974 个，运行时 845 个，`server/` 的 29 个测试文件中 513 个， `deploy/ci/` 的九个测试文件中 138 个。

### 权限：AUMLOK 与所有者的 passkey

除非给出更长的路径，代码都在 `deploy/cloudflare/src/`，测试都在 `deploy/cloudflare/src/__tests__/`。

- **精确字节，只用一次。** passkey 签署的是一个随机挑战，边缘端把这个挑战绑定到一个请求的来源、方法、路径和请求体哈希（`aumlok.mjs` 中的 `aumlokClass3Binding`），所以这次批准只能用在这些字节上。批准有效五分钟，只能用一次。对她的 GitHub 帖子，`head-do.mjs` 中的 `consumeClass3` 在同一个存储事务中消耗批准并预留请求体哈希。这个预留永远不会自动释放，结果未知时也不会，所以重新加载页面不会发两次。账本容纳 4,096 个预留，之后就拒绝。测试：`convergence-approval-fencing.test.mjs`（5 个用例）、 `cloud-brokers.test.mjs`（29 个用例）。
- **页面请求批准的正是它展示过的字节。** 对一条暂存的 GitHub 帖子，页面严格读取请求，展示全文，在点击时再读一次文件，只有当它仍是同一个请求时才请 passkey 批准。`packages/client/ui-layout/src/client/spatial/aumlok/outward-class3.ts`。
- **用绑定的 passkey 登录，前面有一道闸门。** 一个会话最长 8 小时，并且不是批准。60 秒内五次签名错误的尝试会把门锁上 300 秒。有一个用例发出 100 次重叠的错误尝试，并断言最多只启动五次签名检查。`aumlok.mjs`、`gate-lockout.mjs`、 `owner-login-slots.mjs`。测试：`owner-passkey-signin.test.mjs`（31 个用例）、`owner-login-gate.test.mjs`（14 个用例）。
- **失败的证明只有一条规则，并且写进了结构。** 只有当一个密码学证明经过检查且确实错误时，锁定计数器才会变动。垃圾输入、过期的挑战或库错误都不计数，所以外人无法把所有者锁在门外。在 `proof-failure-rule.mjs` 中，只有 `proofOutcome` 调用验证器，只有 `countFailure` 变动计数器，而一个结果带有其他模块无法制造的私有标记。passkey 的应答先经过项目自己的解析（`webauthn-screen.mjs`）筛查，在那里不匹配的会被拒绝且不计数。`proof-failure-rule.test.mjs`（11 个用例，1,091 行）用 TypeScript 解析器解析所有者身份相关的源码，追踪改名与命名空间导入、别名、解构和 `bind`，只要在别处调用了验证器或写了计数器就失败。有一个用例要求边缘端每个调用验证器的文件都被列为身份代码或非身份代码并附理由，而未解决例外的清单（`OPEN`）是空的。其中六个用例植入已知的绕过写法，例如改名、解构或绑定后的验证器，或通过 `Reflect` 写入的计数器，并断言扫描能逐一抓住。
- **第二台设备的 passkey。** 一个已登记的 passkey 批准“添加设备”，并得到一个一次性代码：256 个随机比特，只以哈希形式存储，有效十分钟，错五次后作废。新电脑注册一个 passkey，但只是加入。在已登记的 passkey 确认这把确切的密钥之前，它无法登录；这把密钥显示为一个六位数字短语。`passkey-devices.mjs`。测试：`passkey-devices.test.mjs`（69 个用例）。
- **七个词。** 页面用 `crypto.getRandomValues` 抽取七个词，在 11,253,636,424,086 个有效短语（43.36 比特）中均匀抽取，并且只显示一次。它保留的承诺值是 PBKDF2-SHA256，迭代 600,000 次，以节点的公钥作盐。文件头给出了这两项选择的理由。 `packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts`。这些词用 AES-256-GCM 封存一个 32 字节的根。节点的 Ed25519 密钥由这个根派生，封存的根只有在绑定的 passkey 断言之后才会释放。 `packages/client/ui-layout/src/client/spatial/aumlok/aumlok-root.ts`。
- **夜间授权。** 轻触一次 passkey，她就可以独自添加或替换普通 organ，限 12 小时内、12 次使用、每次 8 个 organ。治理 id 永远不在范围内。`night-grant.mjs`、`night-grant.test.mjs`（21 个用例）。
- **她不能修改自己的裁判。** 十五个 id 按名称只归所有者，任何声明自己属于治理的条目也是如此。其中十个是 organ： receipt、Pearl、Aura、预测、回忆、记忆、身体图、超级智能体、scion 和启动。五个是 Wasm 单元：两个裁判、授权账本、身份和密钥。修改其中任何一个，都需要 passkey 对确切的候选字节作出批准。所有者授权必须同时带有 Ed25519 和 ML-DSA-65 签名。`server/ball-transition.mjs`、`deploy/cloudflare/src/owner-grant-policy.mjs`、 `packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`。测试： `deploy/ci/authority-preflight.test.mjs`（10 个用例）、`hybrid-envelope.test.mjs`（6 个用例）。

### 有机体：organ、ball、scion 与 Pearl

Organ 位于 `mirror/home/auma/seed/organs/`。运行时代码在 `packages/experimental/webworker-runtime/src/x6/`，测试在 `packages/experimental/webworker-runtime/tests/x6/`。

- **创世 head。** 每个节点都从同一个 head 开始：epoch 1、没有父版本、26 个条目、作者 `genesis`（ `mirror/home/balls/HEAD.json`），外加 Pearl 套件和六条 scar。此后节点长出的东西是它的世界，`.gitignore` 把它挡在仓库之外。
- **Ball 与 epoch。** ball 是一份清单，按代码的 SHA-256 列出每个 organ，它的 id 就是它自身的哈希。新的 head 必须把当前 ball 作为父版本，并且恰好高一个 epoch。过时的调用者会得到 `REBASE_REQUIRED`。`server/ball-head.mjs`、 `deploy/cloudflare/src/head-do.mjs`。测试：`server/ball-manifest.test.mjs`（6 个用例）。
- **她暂存自己的下一个版本。** 三个工具为所有者暂存它。`stage_organ_promotion` 修改一个 organ， `stage_organ_set_promotion` 添加一到八个普通 organ。两者都克隆在用的 head，加一个 epoch，并把候选版本发到 `/_head/stage`。`stage_head_promotion` 把一个治理候选写进一个审阅文件，交给所有者。它们都不发布，也不批准。 `ball-loader.ts`。测试：`stage-organ-promotion.spec.ts`（10 个用例）。
- **带撤销的在线自我修改。** `tree_patch` 在运行中的智能体里挂载或热替换一个 organ，无需重新加载页面，激活失败会被回滚。`tree_undo` 把一个 organ 恢复到上一个版本，并按后注册先释放的顺序释放它注册过的东西。`self_apply` 把存入新代码和换入作为一步完成，`self_undo` 撤回最近一次修改。`ball-loader.ts`。
- **scion 与一次自建步骤。** `scion.ts` 接收最多 128 个源文件、2 MiB，并在一个独立的 worker 中用固定版本的离线 esbuild-wasm 编译它们。编译既不运行也不选定结果。然后 `seed-cycle.js` 写下 organ、计算哈希、安装、运行验收用例，并保留或撤销它。`scion_grow` 工具把两者连起来（`scion-growth.ts`）。
- **Pearl，以及攻击裁判的测试。** 一个含 17 个用例的保留套件和六条 scar 作为种子文件提供（ `mirror/home/auma/seed/pearl/retention-suite.v1.json`、`mirror/home/auma/seed/scars.jsonl`）。每条 scar 记录一次失败及其教训。六条中有五条点名了现在守护它的检查，共 14 个，而这 14 个每一个都是套件中的用例。`scar-aura-silent-calm` 还没有点名任何检查。`seed-pearl.js` 在一个一次性的试验 worker 中，用整个套件运行一个 organ 的两个构建。在 `scion-growth.spec.ts`（27 个用例，其中一个在已知为红的清单上）中，一个候选版本试图提交伪造的通过，而父版本忽略 worker 的通过标志，重新给输出打分。另见 `server/pearl.test.mjs`（38 个用例）。
- **Receipt、预测与 Aura。** `seed-receipts.js` 保存一个哈希链接的 receipt 日志，带有 Ed25519 签名的 checkpoint。 `seed-predict.js` 在任何东西改变之前，把对下一次晋升的预测封存为一条 receipt，并且不存分数：读者从链上重新计算意外程度。`seed-aura.js` 按固定规则计算她的一致性，它的权限层级永远是 `peripheral-hint`。测试： `server/aura.test.mjs`（16 个用例）、`server/receipts.test.mjs`（10 个用例，其中 6 个在已知为红的清单上）。
- **25 个密封的 Wasm 单元。** `apps/web/public/cells/` 中的每个文件都在 `wasm-cells.ts` 中按大小、SHA-256 和燃料配额固定。加载器按固定顺序接纳一个单元，遇到第一个失败就停止：先查大小，再在私有副本上查哈希，然后查从二进制中读出的内存限制（一块非共享的 32 位内存，带声明的上限），全部在编译之前完成。然后它要求零导入，并且导出集合恰好是计量过的那一组。每次调用都在一个独立的 worker 中以全新的燃料配额运行，该 worker 在 5,000 ms 后被结束，每次调用之后还会重新检查在用的内存。这些单元承担身份、密钥、四个裁判、授权账本、风险、记忆策略、Nostr 签名与加密，以及布局。她用 `x6_cell` 工具调用它们。其中一个单元 skillsmith 把 WAT 文本编译成新的计量单元：`aura-focus.wasm` 就是这样由 `aura-focus.wat` 构建的，如果签入的字节不同，`server/aura-focus-cell.build.mjs` 以退出码 1 结束。测试：`wasm-cells.spec.ts`（13 个用例）。
- **26 个工具。** 除了暂存和自我修改，加载器还注册了这些工具：自我检视（`x6_capability_index`、`x6_browser_estate`、 `auma_snapshot`），经由宿主持有的门向外伸展（`x6_repo`、`x6_github`、`x6_cloudflare`、`x6_web_eyes`），同时向最多六个其他模型征求意见（`x6_consult`），最多六个并行的子智能体任务（`x6_swarm`），带验收条件和步数上限的持久愿望（ `x6_wish`），以及她的 Nostr 身份（`x6_nostr`）。`ball-loader.ts`。测试：`capability-index.spec.ts`（6 个用例）。
- **没有打开标签页也能唤醒。** 一个 Durable Object 闹钟可以唤醒她，进行一次有界的会话：3 轮、6 次工具调用、15 秒（ `deploy/cloudflare/src/head-do.mjs` 中的 `CLOUD_WAKE_LIMITS`）。`deploy/cloudflare/src/cloud-wake-tools.mjs` 增加三个只读的仓库工具，以及经由 `deploy/cloudflare/src/cloud-model-door.mjs` 的一轮模型调用，它自己不写入、不暂存、不晋升、不批准，也不发布任何东西。只有在确切设置 `WAKE_EXECUTOR_ENABLED=1` 时，唤醒才会运行模型（ `deploy/cloudflare/README.zh.md`）。测试位于 `deploy/cloudflare/src/__tests__/`：`cloud-wake-bounds.test.mjs`（ 23 个用例）、`cloud-wake-off-switch.test.mjs`（5 个用例）。打开标签页那一侧是 `wake-loop.spec.ts`（11 个用例）。

### 边缘端：一个 Worker，HEAD 与 MIRROR

除非给出更长的路径，代码都在 `deploy/cloudflare/src/`，测试都在 `deploy/cloudflare/src/__tests__/`。

- **一个 Worker，两个 Durable Object。** `worker.mjs`（2,105 行）检查调用者是谁并路由请求。HEAD（`head-do.mjs`，2,808 行）保存选中的是哪个 ball 以及登录锁定。MIRROR（`mirror-do.mjs`）以有序更新的形式存储她的 home 目录的副本，并拒绝看起来像机密的文件名。测试：`head-hardening.test.mjs`（20 个用例）、`worker.spec.ts`（写出来的 96 个用例，运行时为 98 个，因为有些在循环中生成；其中 5 个在已知为红的清单上）。
- **救援页面与 vault。** `/rescue` 复制一个浏览器所持有的 Auma，既不启动她的应用，也不向那个浏览器写入。它把副本发送到 vault，分成按 SHA-256 命名的片段；或者保存为一个打包文件，由 `server/rescue-verify.mjs` 重新计算哈希。 `rescue-kit.mjs`、`rescue-page.mjs`、`vault.mjs`、`world-budget.mjs`。测试：`rescue-pack.test.mjs`（22 个用例）、 `rescue-page.test.mjs`（31 个用例）。
- **有界归档，以及只向空边缘端的恢复。** `cold-archive.mjs`（2,055 行）把边缘端状态写成一个按内容寻址、绑定到所有者的归档，并带有一个以自己的对象名运行的重建演练。`recovery-restore.mjs` 只写入一个既没有 HEAD 也没有镜像的边缘端。对在用的边缘端只做比较。测试：`cold-archive-bounded.test.mjs`（44 个用例）、`recovery-restore.test.mjs`（34 个用例）。
- **模型门，以及在调用之前写下的日志。** 模型调用经由同源的 `/door/<provider>/`，通过七道门通往六个提供方： `deepseek`、`moonshot`（两道门）、`openrouter`、`openai`、`anthropic` 和 `xai`（ `packages/experimental/webworker-runtime/src/model-doors.ts`）。门让宿主可以加上一个只有宿主持有的密钥。 `turn-journal.mjs` 在调用提供方之前，把这一轮以及请求的 SHA-256 提交到存储，所以崩溃的标签页不会丢失所问的内容。当调用在发出之后失败，`provider-dispatch.mjs` 回答 `PROVIDER_OUTCOME_UNKNOWN` 并附带 `do-not-repeat-automatically`。测试：`provider-dispatch.test.mjs`（17 个用例）、`turn-journal-and-body.test.mjs`（5 个用例）。
- **向外工作的代理。** 通过 `/_host/repo`，她读取仓库，并在名为 `auma/proposal/<name>` 的分支上工作。发布需要 passkey 批准，结果未知时就回答未知。`cloud-brokers.mjs`。测试：`repo-brokers.test.mjs`（43 个用例）。
- **部署闸门。** `deploy/ci/` 包含一个扫描源码和构建产物的清洗闸门、权限预检、一条规定 head 同步可以提交什么的规则，以及一个固定生产凭据在工作流中可出现位置的测试。共九个测试文件，其中包括 `deploy/ci/scrub-gate.test.mjs`（25 个用例）。
- **签名的 head 公告，以及本地宿主。** `nostr-anchor.mjs` 发布一条 kind 30078 的 Nostr 事件，由节点密钥签名，说明哪个 ball 和 epoch 是她的 head。该文件说明它不是 relay。`server/local-host.mjs` 在一台机器上模拟 HEAD 和镜像， `server/cloudflare-bootstrap-cli.mjs` 的试运行从不写入也不连接。测试：`nostr-anchor-door.test.mjs`（26 个用例）、 `server/cloudflare-bootstrap.test.mjs`（13 个用例）。

### 应用：Spatial

代码位于 `packages/client/ui-layout/src/client/spatial/` 下，下文写作 `spatial/`。spec 位于 `packages/client/ui-layout/tests/`。它们在 jsdom 中运行，而 jsdom 不做布局。

- **一个工作区，三条通道，一种手机布局，一份契约。** 线程、打开的应用和菜单。框架在十种具名布局之间吸附切换，在 1023px 及以下一次只显示一条通道（`spatial/stores.ts`、`spatial/SpatialFrame.module.css`）。`scripts/spatial-catalogue.ts` 从组件源码生成 `docs/foundations/SPATIAL-CATALOGUE.md`，提交的文件一旦过时，它的 spec 就失败。测试： `app-frame.client.spec.tsx`（43 个用例）、`spatial-compact.client.spec.tsx`（60 个用例）、 `scripts/spatial-catalogue.spec.ts`（7 个用例）。
- **Sovereignty。** 一个界面展示管理这个节点的一切：持久性、密钥与信任、receipt 链、已发布的 Pearl 以及唤醒开关。它的批准卡片在请 passkey 之前，先从字节重建条款（`spatial/aumlok/head-promotion.ts`）。 `spatial/portal/SovereigntySurface.tsx`。测试：`sovereignty-durability.client.spec.tsx`（29 个用例）。
- **代码差异与链的判定。** `spatial/portal/organ-code-diff.ts` 展示运行中的 organ 与暂存的 organ 之间的确切改动。 `spatial/portal/receipt-chain-verdict.ts` 检查 receipt 账本是否延续了最后一个 checkpoint，并回答 `APPEND_ONLY`、 `OBSERVATION_CONFLICT` 或 `UNDETERMINED`。测试：`organ-code-diff.client.spec.ts`（15 个用例）、 `receipt-chain-verdict.client.spec.ts`（8 个用例）。
- **Identity 与 Work。** Identity 持有所有者的密钥卡、设备列表、邀请和 Nostr 身份（`spatial/apps/identity/`）。Work 展示哪些已获授权、正在运行、被阻塞或在等所有者（`spatial/work/WorkSurface.tsx`）。测试： `identity-devices.client.spec.tsx`（20 个用例）、`work-autonomy.client.spec.tsx`（81 个用例）、 `host-facts.client.spec.tsx`（110 个用例）。
- **Media 与 Documents。** 一个只读的盘，存放她的截取内容和文档。一条盘规则拒绝看起来像机密的名称和任何含 `..` 段的路径，并且只在三个文件夹内打开文件。`spatial/apps/media/drive-rule.ts`。测试：`media-drive.client.spec.tsx`（28 个用例）、`media-drive-rule.client.spec.ts`（12 个用例）。
- **内置应用。** Auma Live 是语音应用（`apps/web/public/assets/stock-apps/auma-live.html`、 `apps/web/public/app/aumalive.js`）。提供方的密钥留在宿主上，页面得到一个短时有效的通行凭证（ `apps/web/public/app/deepgram-voice.js`）。测试：`auma-live-deepgram-voice.client.spec.ts`（17 个用例）、 `auma-live-isolation.client.spec.tsx`（4 个用例）。Auma Lingwa 教她的语言（ `apps/web/public/assets/stock-apps/auma-lingwa.html`），`apps/web/public/app/auma/canon-v16.json` 中有 84 天的学习旅程和 948 个词汇条目。Zeta Harp 和 Dakini Code 在同一个 `stock-apps/` 文件夹中。上面统计过的文件夹里，没有测试覆盖 Auma Lingwa、Zeta Harp 或 Dakini Code。
- **智能体运行在浏览器 worker 中。** `packages/experimental/webworker-runtime/` 在 WebWorker 中挂载一个打包的文件系统，把她的 home 目录保存到 IndexedDB，并向镜像发送有序更新（`src/storage/idb-persist.ts`）。测试： `tests/storage/memory-vfs.spec.ts`（20 个用例）。

## 自己检查

本文件没有任何内容要求你凭信任接受。它的写法是为了让一个人，或替一个人阅读的 AI，能逐行检查。

- **任选“已经建成的部分”中的一行。** 打开那个路径，读它的头部注释。然后打开旁边点名的测试，读它断言了什么。
- **重新清点。** 运行“这些数字”中的清点命令。数字对不上，就是本文件的错。
- **运行测试。** 命令在“运行它”中。把任何失败与 [docs/KNOWN-RED-TESTS.zh.md](docs/KNOWN-RED-TESTS.zh.md) 对照。不在那份清单上的失败就是新情况。
- **这棵树能展示什么，不能展示什么。** 它展示写成的代码和测试，以及作者在一台机器上的一次运行（[docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md)）。那是一份记录，不是保证：在你机器上的通过、已部署的节点、浏览器会话或速度，都要由你自己来测。
- **继承了什么。** `packages/` 的大部分是继承来的 DeepSeek Harness，它建立在 Cordis 之上，Cordis 内置在 `vendor/` 中。 Aukora 自己的代码主要在 `deploy/`、`server/`、`mirror/`、`apps/web/public/` 以及上面点名的 `packages/` 路径。
- **passkey 规则止于何处。** 只有这里点名的动作才会请 passkey。修改一个普通 organ 需要已签名的所有者会话，而不是 passkey（`server/ball-transition.mjs`）。哈希链不是批准：`docs/START-HERE.zh.md` 写明 checkpoint 不是 passkey。

## 名称的朴素含义

[docs/GLOSSARY.zh.md](docs/GLOSSARY.zh.md) 定义了 ball、organ、epoch、receipt、checkpoint、head 以及其余机制术语。项目自己的名称在这里解释。

- **Auma**：住在节点上的 AI。**Organ**：她的模块，每一个都是一个 Cordis 插件（Cordis 是 `vendor/` 中的插件框架）。 **Ball**：按内容寻址的模块包，用一个整数（epoch）标记版本。**HEAD** 与 **MIRROR**：边缘端的两个 Durable Object。HEAD 选定 ball，MIRROR 保存她的 home 目录。
- **AUMLOK**：身份之门：passkey 注册、所有者登录、设备、七个词、邀请以及精确字节批准（ `deploy/cloudflare/src/aumlok.mjs`）。
- **Aura**：她的一致性读数（`mirror/home/auma/seed/organs/seed-aura.js`）。在有宿主为其供数之前，Aura Coherence 界面把每个健康格子都画成 Undetermined（`packages/client/ui-layout/src/client/spatial/aura/model.ts`）。
- **Kira**：五个 Wasm 单元上的名称（`apps/web/public/cells/` 中的 `kira-*.wasm`）。它们固定的操作对笔记分类、为回忆排序、设置存储权限、跨越一层膜接纳，以及签署 Nostr 事件（`wasm-cells.ts` 中的 `ops` 列表）。回忆 organ 是 `seed-recall.js`。成文的文档没有进一步定义 Kira。**Aperture** 是一个项目名称，这棵树中还没有代码使用它。
- **Scion**：她所提议的 organ 的编译器。**Pearl**：她从弄坏东西中留下的东西：候选版本要对照运行的保留套件，以及称为 scar 的奠基教训。**Spatial**：每个界面都遵循的唯一工作区设计（`docs/foundations/SPATIAL-DESIGN-RULES.md`）。**Auma Lingwa**：她的语言，脚本与课程在 `apps/web/public/app/auma/`。

## 先读这个，再读这个

先给普通读者，不需要看代码；再给工程师。每个文件都先读它的头部注释。

1. `mirror/home/auma/seed/scars.jsonl`：六条奠基失败，每条带着它的教训，以及守护其中五条的检查。
2. [`docs/START-HERE.zh.md`](docs/START-HERE.zh.md) 与 [`docs/GLOSSARY.zh.md`](docs/GLOSSARY.zh.md)：角色、风险与术语。
3. [`docs/KNOWN-RED-TESTS.zh.md`](docs/KNOWN-RED-TESTS.zh.md)：每一个已知失败的测试及其原因。
4. `deploy/cloudflare/src/proof-failure-rule.mjs`，然后是 `deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs`：失败规则，以及守住它的扫描。
5. `deploy/cloudflare/src/passkey-devices.mjs` 与 `deploy/cloudflare/src/aumlok.mjs`：第二台设备，精确字节批准。
6. `server/ball-head.mjs`，然后是 `deploy/cloudflare/src/head-do.mjs`：epoch 加一规则，本地一份，边缘端一份。
7. `mirror/home/auma/seed/organs/seed-cycle.js`、`seed-receipts.js`、`seed-pearl.js`：构建步骤、receipt、Pearl。
8. `packages/experimental/webworker-runtime/src/x6/scion.ts` 与 `wasm-cells.ts`：编译器与单元加载器。
9. `deploy/cloudflare/src/rescue-kit.mjs`、`deploy/cloudflare/src/vault.mjs` 与 `deploy/cloudflare/src/cold-archive.mjs`：救援副本、vault 与有界归档。
10. `deploy/cloudflare/README.zh.md`：边缘端的限制与引导驱动程序。

## 这里没有什么，以及什么尚未证明

- **没有任何节点的世界。** 这棵树不包含任何真实节点的 receipt、记忆、对话记录、快照、密钥或 checkpoint。本文件不声称任何测得的速度或负载。
- **一次记录的运行，以及它没有覆盖的部分。** [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md) 记录了在一台机器上的安装、构建、启动本地宿主，以及“运行它”中的测试命令。它没有记录部署到 Cloudflare、浏览器会话、模型调用或 passkey 仪式。
- **有些测试已知为红。** [docs/KNOWN-RED-TESTS.zh.md](docs/KNOWN-RED-TESTS.zh.md) 列出每一个，附数量和原因。没有一个被删除、跳过或削弱。清单中包括 receipt、回忆和预测这几个 organ 的测试，以及记录的运行新发现、至今仍为红的那一个失败。
- **已说明的缺口。** `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` 复现了这一点：把整个存储快照回滚，可能让一次已用掉的批准重新生效。`seed-pearl.js` 说明它的试验不是已证明的隔离。`scion_grow` 在在用的 organ 上运行验收用例，而不是在隔离环境中。
- **部署触发器是关闭的。** `.github/workflows/` 中没有任何工作流保留自动触发器。原来有的都已注释掉，并标记为 `[disabled in aukora-x7]`，只剩手动触发。37 个工作流文件大多继承自上游；它们全都是设计，不是运行记录。
- **有些源码不在树中。** 25 个 Wasm 单元中的 24 个、`pentora36.wasm` 和 Dakini Code 包以预构建形式提供，不带源码。见许可证一节。

## 运行它

作者在一台机器上 RAN 过：每一行的结果都在 [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md) 中，两行 `vitest` 命令加了 `--maxWorkers=3`。每一行运行一次，只有应用那一行在导出更正之后又运行了一次。那是一份记录，不是保证这些命令在你的机器上会成功。

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

- Node 24.9 或更新版本与 pnpm 11.28.5 固定在 `package.json` 中。`pnpm run x6:start` 在 127.0.0.1 上运行 `server/local-host.mjs`，所有者的值来自 `X6_OWNER_EMAIL` 与 `X6_OWNER_PUBLIC_KEY_HEX`。
- **警告：** `node server/build-preview.mjs` 会在替换旧构建之前和完成时，向 `http://127.0.0.1` 上 `PORT`（默认 4610）的宿主发送 POST。监听在那里的宿主，无论是你的还是别的程序，都会被改动。不需要触碰任何运行中的宿主时，请像上面那样把 `PORT` 设为没有程序监听的端口。
- **没有 `.git` 的副本，以及离线安装。** 构建用 `git rev-parse HEAD` 读取提交，没有时退出码为 1。这时请改设 `DSH_CLIENT_COMMIT_HASH`，值为 7 到 40 位十六进制数字的任意值，例如 `0000000`：`scripts/client-build-environment.ts` 用它代替 Git，拒绝其他形式，并保留前七位。用 `--offline` 安装时，除了存储中的包，pnpm 缓存中必须已经有注册表元数据；没有的话，请联网安装。两者都 RAN。
- 不要从 `pnpm run x6:build` 开始：据报告在新克隆上它会失败（`UNRESOLVED_ENTRY`），因为它需要 `pnpm run build:lib` 或预览构建产出的 `lib/` 目录。此处 UNVERIFIED。
- **部署前请修改占位值。** 节点名称、主机、账户 id 和仓库都是占位值：`your-node`、`node.example.invalid`、全零的账户 id 和 `your_org_x/your-node`。它们在 `deploy/cloudflare/wrangler.toml` 中，也写在代码里，所以新节点要在那里一并修改：Worker 名称在 `server/deploy-cloudflare.mjs` 和 `deploy/cloudflare/src/cloud-brokers.mjs` 中，源地址在 `server/seed-cloudflare.mjs`、`server/cloudflare-bootstrap-cli.mjs`（它拒绝其他任何 `--url`）以及 `deploy/ci/` 中的四个脚本中，仓库在 `server/deploy-cloudflare.mjs` 和 `cloud-brokers.mjs` 中。 `grep -rlE 'your-node|example\.invalid|your_org_x' server deploy .github` 列出持有占位值的每一个文件。 `deploy/cloudflare/README.zh.md` 是指南。有些代码注释引用了一份名为 NORTH-STAR 的文档，它不在这棵树中。
- **部署脚本会先询问 GitHub。** 除非给出 `--deploy`，`server/deploy-cloudflare.mjs` 只打印它的命令。部署之前，它用 GitHub CLI（`gh`）询问仓库的生产环境是否已经持有 Cloudflare 凭据。如果 `gh` 缺失或无法回答，它就拒绝，除非同时给出 `--emergency`。
- 请给节点一个它自己的私有仓库。head 同步会把节点的世界提交到所配置仓库的 `main`，绝不能是共享的源码仓库。

## 它要去哪里

DIRECTION。下面没有一项已按所述建成。

- **端到端的自建：** 她提议自己的新版本，scion 构建它，她运行它，所有者批准这个确切的改动，然后它才成为在用的版本。各个部件已经建成。整条回路在已部署节点上的运行，这棵树中没有记录。
- **她更多地用 Wasm，节点随处可起。** 在这棵树中，organ 是 JavaScript，25 个单元是 Wasm。浏览器运行智能体，云端唤醒是有界的，除非打开否则是关闭的（`deploy/cloudflare/README.zh.md`）。
- **一个人的网络：** 节点由真人邀请相连，签名事件在节点之间承载同一份记录。在这棵树中有邀请和签名的 head 公告，没有 relay。

## 许可证，以及这棵树不包含什么

许可证：GNU Affero 通用公共许可证 v3.0 或更新版本（`AGPL-3.0-or-later`）。全文见 [LICENSE](LICENSE)。上游 DeepSeek Harness 采用 MIT，其声明原样保存在 [LICENSES/MIT-DeepSeek-Harness.txt](LICENSES/MIT-DeepSeek-Harness.txt) 中。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Aukora 与 DeepSeek 没有隶属关系，也未获其背书。

每一个部署值都是占位值，如“运行它”中所列。`mirror/home/auma/seed/organs/seed-receipts.js` 中固定的 checkpoint 签名公钥是合成的：该文件说明没有人持有对应的私钥。

源码不在本仓库中的预构建文件：`apps/web/public/cells/` 中的 Wasm 单元，`aura-focus.wasm` 除外，它的源码 `aura-focus.wat` 就在这里；`apps/web/public/seed-library/pentora/` 中的 `pentora36.wasm`；以及 Dakini Code 包。每处旁边各有一份 `LICENSE.binaries` 作出说明。单元和 Dakini Code 的说明称这些文件适用根目录的 AGPL，并说明在其源码尚未发布期间的后果。在这里发布这些源码，或给出其他条款，是版权持有人尚未作出的决定。`pentora36.wasm` 不同：本仓库尚未为它授予任何许可，根目录的 AGPL 和单元的说明都不覆盖它，它的条款由其版权持有人来说明。
