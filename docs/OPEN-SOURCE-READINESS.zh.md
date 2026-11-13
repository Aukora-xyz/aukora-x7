# 开源就绪情况

[English](OPEN-SOURCE-READINESS.md) | 中文

本仓库以 AGPL-3.0-or-later 发布，但它**还不是任何人都能完整重建的一套系统。**一些做决定的部分只以编译后的文件形式提供，有一个编译文件完全没有许可证，还有一些构建输入在这棵树之外。本页按优先级列出每一个已知缺口，说明谁能补上，并说明读者今天能复现什么、不能复现什么。

这些都还没有解决。只有当修复进入这棵树，某个缺口才会从本页消失。

本页使用的标签：IMPLEMENTED（代码和测试在这棵树里）、RECORDED RUN（见 [RUN-RECORD.zh.md](RUN-RECORD.zh.md)，一次属于较早的一棵树的运行）、INDEPENDENTLY VERIFIED（目前没有任何东西带这个标签）、UNVERIFIED（有人声称或写出来了，但这里没有测试守住它，或没有运行记录显示它）、DIRECTION（尚未构建）。

下文用到两个词：organ（器官）是 Auma 的一个可替换模块，Auma 是本仓库里的 AI；ball（球）是按哈希列出每个 organ 的清单。

## 缺口，按优先级排列

### 1. 25 个 Wasm 单元中有 24 个无法重建

这些单元是小型的、封存的 WebAssembly 模块（见 [GLOSSARY.zh.md](GLOSSARY.zh.md)）。它们保存身份、密钥、裁判、授权账本、记忆策略和 Nostr 签名。只有所有者的 passkey 才能更改的 15 个 id 中，有 5 个是单元（`server/ball-transition.mjs` 中的 `T2_ONLY_ORGANS`）。

- 在树里：`apps/web/public/cells/` 中有 24 个编译文件（6,488,165 字节），每个都在 `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts` 中按大小和 SHA-256 钉住。只有 `aura-focus.wasm` 的源码在它旁边（`aura-focus.wat`），`server/aura-focus-cell.build.mjs` 检查发布的字节是否与它一致。这次重建用被钉住的 `skillsmith` 单元作编译器，而 `skillsmith` 正是没有源码的 24 个之一。
- 不在树里：任何 Rust 源码。这里没有 `.rs` 文件，也没有 `Cargo.toml`（用 `find` 检查过）。大多数单元共用的 `mv_abi` crate 不在 crates.io 上，它的源码也不在这棵树里（`apps/web/public/cells/THIRD-PARTY.md`，第 10 行和第 11 行）。在那张表里，13 行第三方 crate 和 Rust 标准库一行的版本都写着“not visible”。树里没有写明编译器版本和目标平台。
- 许可证后果：按 AGPL 第 5 条和第 6 条，转交目标代码的人必须同时提供它的源码。收到本仓库的人，仅凭本仓库无法履行这项义务（`apps/web/public/cells/LICENSE.binaries`）。
- 需要：带有 `mv_abi` 的单元工作区、它的锁文件、编译器和目标平台版本、构建命令，以及 `wasm-cells.ts` 中每个钉住项的预期 SHA-256。或者在那份说明里为这些编译文件写明其他条款。
- 由谁来做：版权持有人。
- 在那之前：任何单元与任何源码相符，都是 UNVERIFIED。

### 2. `pentora36.wasm` 没有许可证

- 在树里：`apps/web/public/seed-library/pentora/pentora36.wasm`，64,892 字节，已编译，没有源码。
- 它的说明写着，本仓库目前没有授予任何许可证；根许可证和单元说明都不涵盖它（`apps/web/public/seed-library/pentora/LICENSE.binaries`）。运行它的页面代码说，它的检查由 `core.mjs` 和 `fixtures/cases.json` 定义，而这两个文件都不在树里（`packages/client/ui-layout/src/client/spatial/aura/pentora-wasm.ts`，第 5 行）。
- 需要：一份许可证声明、它的源码和那两个检查文件，或者删除这个文件。
- 由谁来做：它的版权持有人。
- 在那之前：复制、修改或转交这个文件之前，先问它的版权持有人。

### 3. Dakini Code 以没有源码的构建包形式发布

- 在树里：Dakini Code 是自带应用之一。它以三个构建文件的形式放在 `apps/web/public/assets/stock-apps/dakini-code/assets/`（1,055,208 字节）。
- 与第 1 项相同的 AGPL 义务（`apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries`）。
- 需要：源码及其构建方式，或其他条款。由谁来做：版权持有人。

### 4. 没有具名的版权持有人，也没有贡献条款

- 106 个 JavaScript 和 TypeScript 文件带有“The Aukora authors”文件头（用 `grep -rl` 统计）；树的其余部分依靠根目录的 [LICENSE](../LICENSE)。没有文件级的对照表说明哪些行是原创、哪些是继承的；[SIZE-AND-ORIGIN.zh.md](SIZE-AND-ORIGIN.zh.md) 按文件夹给出数量。
- 除根目录外，有 17 个文件夹带有自己的 `LICENSE` 文件（用 `find . -name LICENSE` 统计，不含 `LICENSES/`），其中有 `native/system/` 里的 BSD-3-Clause，以及 `packages/fs/fs-patch/` 里对另一个项目的改编。
- 没有贡献者协议，也没有签署规则。在有之前，[CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md) 要求每个拉取请求写明其许可证。
- 需要：一个具名的持有人或实体、一条贡献规则、一份生成的来源对照表。由谁来做：版权持有人。

### 5. 树里无法显示的条款

- 一个智能体 SDK 包，以及它声明的八个平台包，在各自文件中被标为“SEE LICENSE IN”（[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，第 35 行和第 188 至 195 行），并由一条授权声明涵盖（第 182 行）。这是否符合其发布方的条款，是 UNVERIFIED，而且这些条款不在 `LICENSES/` 里。
- `packages/client/ui-layout/src/client/spatial/apps/identity/qr.ts`（第 3 至 7 行）里的二维码编码器转述了一份第三方 MIT 声明，而该项目不在声明表里。
- 由谁来做：这些条款的发布方；声明部分由维护者负责。

### 6. 没有记录可复现的构建

- 有一次构建在一台机器上运行（RECORDED RUN（属于较早的一棵树））。没有第二台机器比较过 `apps/web/dist` 的哈希，或演练球的 id `a26b7a027014e6af067a0a8433c49c56639ac09642726110c91f8300e9e81624`。
- 构建需要 `.git` 或 `DSH_CLIENT_COMMIT_HASH`，并且默认会向 4610 端口上的一个主机发送请求（`server/build-preview.mjs`，第 43 至 55 行）。
- 由谁来做：任何第二个构建者；构建脚本由维护者负责。

### 7. 检查点签名者是合成的

- 两个被钉住的检查点签名密钥是合成的；没有人持有私钥那一半（`mirror/home/auma/seed/organs/seed-receipts.js`，第 37 行）。树里没有找到替换它们的文档化流程。新节点如何获得真实的签名者，是 UNVERIFIED。
- 这项更改涉及只有所有者的 passkey 才能更改的名单上的一个 organ，所以由所有者批准确切的字节。

### 8. 部署值是写进代码里的占位符

- `your-node`、`node.example.invalid` 和全零的账户 id 放在 `deploy/cloudflare/wrangler.toml` 里。同样的值，以及仓库占位符 `your_org_x/your-node`，也被写进了代码，其中包括 `server/deploy-cloudflare.mjs`（第 21、24 行）、`deploy/cloudflare/src/cloud-brokers.mjs`（第 8、1700 行）、`server/seed-cloudflare.mjs`（第 14 行）、`server/cloudflare-bootstrap-cli.mjs`（第 6 行）、`deploy/ci/deploy-guard.mjs`（第 44 行）和 `server/owner-grant.mjs`（第 116 行）。`grep -rlE 'your-node|example\.invalid|your_org_x' server deploy` 会把它们连同测试和文档全部列出。
- 从这棵树部署到一个新账户，是 UNVERIFIED。
- 由谁来做：维护者。

### 9. 放在别处的源码

- `vendor/` 中的引入代码钉在外部提交上（`vendor/README.md`）。
- MPL-2.0 转换工具包的源码在一个外部仓库里（[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，第 200 至 202 行）。
- 需要：把它们镜像进树里，或按哈希钉住。由谁来做：维护者。

## 必须发布、重建或授权的内容

| 内容 | 行动 | 由谁来做 | 状态 |
| --- | --- | --- | --- |
| 24 个 Wasm 单元 | 发布源码、`mv_abi`、锁文件、工具链、构建命令、预期哈希 | 版权持有人 | 未完成 |
| `pentora36.wasm` | 写明许可证、发布源码和检查文件，或删除 | 它的版权持有人 | 未完成 |
| Dakini Code 构建包 | 发布源码和构建方式，或写明其他条款 | 版权持有人 | 未完成 |
| 版权与贡献 | 指定持有人，设定贡献条款 | 版权持有人 | 未完成 |
| 智能体 SDK 与平台包 | 把适用条款放进 `LICENSES/`，或确认它们 | 其发布方，然后是维护者 | 未完成 |
| 二维码编码器声明 | 加入声明表 | 维护者 | 未完成 |
| 构建 | 第二个构建者比较哈希 | 任何人 | 未完成 |
| 检查点签名者 | 真实的签名者和替换流程 | 每个节点的所有者 | 未完成 |
| 部署值 | 为它们设一个来源，由代码读取 | 维护者 | 未完成 |
| 外部源码 | 镜像或按哈希钉住 | 维护者 | 未完成 |

## 读者今天能复现什么

| 能做的事 | 怎么做 | 标签 |
| --- | --- | --- |
| 不用安装就运行 22 个测试文件；预期最后一行为 `verify-lite: 22 files, 564 pass, 12 fail, 12 of 12 on the known-red list` | `node scripts/verify-lite.mjs`（Node 24.9 或更新版本） | UNVERIFIED：在一台机器上看到过，不在记录的运行（属于较早的一棵树）里 |
| 对照钉住的值检查每个单元文件，不运行它 | 对 `apps/web/public/cells/*.wasm` 和 `wasm-cells.ts` 的 SHA-256 循环（见 [WHAT-IS-BUILT.zh.md](WHAT-IS-BUILT.zh.md)） | IMPLEMENTED |
| 用没有源码的 `skillsmith` 单元作编译器，从 `aura-focus.wat` 重建 `aura-focus.wasm` | `server/aura-focus-cell.build.mjs`；测试 `server/aura-focus-cell-shadow.test.mjs` | IMPLEMENTED |
| 安装、构建、启动本地宿主、运行四个测试套件、运行演练 | [CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md)，第 3 节 | 在一台机器上的 RECORDED RUN（属于较早的一棵树） |

## 读者今天不能复现什么

- 重建 24 个单元、`pentora36.wasm` 或 Dakini Code 构建包，或者检查其中任何一个是否与任何源码相符。
- 按 pentora 检查自己的定义文件所描述的方式运行这些检查：这些文件不存在。
- 不安装就运行授权测试。
- 逐哈希复现一次构建：没有任何比较存在。
- 运行固件来源检查：它需要项目更早的 Git 历史，而这段历史没有公开；本仓库的公开历史从它的第一个公开提交开始（`server/fixtures/organs/pinned.mjs`）。
- 复现继承行与新增行的确切划分：这需要私有历史。一种接近的公开方法见 [SIZE-AND-ORIGIN.zh.md](SIZE-AND-ORIGIN.zh.md)。
- 让 `mirror/home/auma/seed/organs/auma-body-map.js` 越过它的文档检查：当它要找的规划文档不存在时，它会抛出错误（第 189 至 191 行），而树里没有放它尝试的任何一个路径。
- 不改代码就部署到一个新账户：见第 8 项。
- 看到任何已部署的节点、浏览器会话、模型调用或 passkey 仪式：没有任何一项有记录。
