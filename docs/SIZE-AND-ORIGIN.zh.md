# 规模与来源

[English](SIZE-AND-ORIGIN.md) | 中文

<!-- 生成的数字：本页每个数字都放在带稳定键的 N 标记里。生成器在导出时根据来源统计重新填写。不要手工修改这些数字。 -->

在你断定本仓库只是换了名字的分叉之前，请先读这一页。它说明这棵树有多少是继承来的，本项目改动或新增了多少，以及有多少以二进制文件形式发布、没有源码。所有数字针对的是这棵树的 <!--N:tree.entries-->21,044<!--/N--> 个条目。

## 简短回答

本项目起步于 DeepSeek Harness，一个采用 MIT 许可的智能体运行时。它的许可声明保存在 [`LICENSES/MIT-DeepSeek-Harness.txt`](../LICENSES/MIT-DeepSeek-Harness.txt)。它的插件框架 Cordis 以源码形式 vendor 在 [`vendor/`](../vendor/README.md) 中。

- **这棵树的大部分是继承来的。** <!--N:all.files-->21,044<!--/N--> 个条目中有 <!--N:all.unchanged.files-->19,873<!--/N--> 个（<!--N:all.unchanged.files.pct-->94.4<!--/N-->%）是本项目没有改动的继承文件。其中一些在发布时改写了名称、链接或占位符（见[统计方法](#how-it-was-counted)）。在文本行中（不含 vendor 代码），<!--N:all.inherited.pct-->89.5<!--/N-->% 是继承来的。
- **本项目自己的文本约占十分之一。** 在 <!--N:all.text.lines-->2,618,877<!--/N--> 个文本行中，有 <!--N:all.own.lines-->275,624<!--/N--> 行（<!--N:all.own.pct-->10.5<!--/N-->%）是本项目改动或新增的。只算源代码，则是 <!--N:code.text.lines-->1,794,093<!--/N--> 行中的 <!--N:code.own.lines-->231,765<!--/N--> 行（<!--N:code.own.pct-->12.9<!--/N-->%）。
- **`packages/` 的大部分是继承来的运行时。** 它的 <!--N:top.packages.files-->11,290<!--/N--> 个文件中有 <!--N:top.packages.unchanged.files-->10,814<!--/N--> 个没有改动，其文本行中有 <!--N:top.packages.own.pct-->6.0<!--/N-->% 属于本项目。
- **本项目的一部分工作以没有源码的形式发布。** 有 <!--N:all.prebuilt.files-->28<!--/N--> 个文件（<!--N:all.prebuilt.bytes-->7,608,265<!--/N--> 字节，占这棵树字节数的 <!--N:all.prebuilt.bytes.pct-->4.6<!--/N-->%）是已编译的文件，其源码不在本仓库中：<!--N:cells.wasm.files-->25<!--/N--> 个 WebAssembly cell 中的 <!--N:prebuilt.cells.files-->24<!--/N--> 个、`pentora36.wasm`，以及 Dakini Code 包的 <!--N:prebuilt.dakini.files-->3<!--/N--> 个文件（它是 `apps/web/public/assets/stock-apps/` 中的自带应用之一）。见[没有源码的二进制文件](#binary-files-without-source)。
- **本项目自己的层集中在少数几处。** 六个文件夹共有 <!--N:ownlayer.lines-->134,107<!--/N--> 行，占本项目全部自有行数的 <!--N:ownlayer.pct-of-own-->48.7<!--/N-->%。它们在下一节列出。

这些数字的成熟度：UNVERIFIED。本项目在发布前根据自己的历史统计了一次，这段历史并未公开。没有别人运行过这次统计。INDEPENDENTLY VERIFIED：本页没有任何内容带这个标签。读者可以自己核对的部分见[你可以复现什么](#what-you-can-reproduce)。

## 本项目自己的层在哪里

这六个文件夹中没有任何文件来自上游项目。其中每一个文本行都是本项目的。

先说两个词。Auma 是本项目构建的个人 AI，由小型、可替换的模块组成，本项目把每个模块称为 organ。一组 organ 作为一个内容寻址的包存放，本项目把它称为 ball。

| 文件夹 | 里面有什么 | 文件数 | 文本行数 |
|---|---|---:|---:|
| [`deploy/cloudflare/src/`](../deploy/cloudflare/src/) | 在 Cloudflare 边缘端运行、核对所有者 passkey 的代码：passkey 与设备检查（`aumlok.mjs`、`passkey-devices.mjs`），所有者授权策略（`owner-grant-policy.mjs`），一次 passkey 可为普通 organ 修改给出的有限授权（`night-grant.mjs`），保险库与救援包（`vault.mjs`、`rescue-kit.mjs`），以及 `__tests__/` 中的测试。 | <!--N:own.edge.files-->131<!--/N--> | <!--N:own.edge.text.lines-->55,377<!--/N--> |
| [`server/`](../server/) | 本地宿主及其所应用的规则，连同测试：ball 头（`ball-head.mjs`、`ball-transition.mjs`），所有者授权（`owner-grant.mjs`），Aura 背后的固定规则，也就是她的一致性读数（`aura-rules.mjs`：确定性的、不具权威的评分）。 | <!--N:own.server.files-->68<!--/N--> | <!--N:own.server.text.lines-->23,420<!--/N--> |
| [`mirror/home/auma/seed/`](../mirror/home/auma/seed/) | Auma 的起始 organ：`organs/` 下的 <!--N:seed.organs-->26<!--/N--> 个小型 JavaScript 模块。同样的 organ 还按内容哈希存放在 `mirror/balls/` 和 `mirror/home/balls/` 下。 | <!--N:own.seed.files-->28<!--/N--> | <!--N:own.seed.text.lines-->7,158<!--/N--> |
| [`packages/experimental/webworker-runtime/src/x6/`](../packages/experimental/webworker-runtime/src/x6/) | 在浏览器内从 ball 运行 organ 的加载器（`ball-loader.ts`），`wasm-cells.ts` 中的 WebAssembly cell 加载器，以及 `scion.ts` 中的 scion，即在独立 worker 里构建她所提议 organ 的编译器。 | <!--N:own.loader.files-->13<!--/N--> | <!--N:own.loader.text.lines-->11,144<!--/N--> |
| [`packages/client/ui-layout/src/client/spatial/`](../packages/client/ui-layout/src/client/spatial/) | 用户界面，本项目称之为 Spatial。 | <!--N:own.spatial.files-->129<!--/N--> | <!--N:own.spatial.text.lines-->36,239<!--/N--> |
| [`apps/web/public/cells/`](../apps/web/public/cells/) | 已编译的 WebAssembly 模块，本项目称之为 cell。只有 `aura-focus.wat` 是源码；其余 <!--N:own.cells.prebuilt.files-->24<!--/N--> 个 cell 是二进制文件（见下文）。 | <!--N:own.cells.files-->28<!--/N--> | <!--N:own.cells.text.lines-->769<!--/N--> |

按顶层文件夹计，本项目自己的行数是：`packages/` 中 <!--N:top.packages.own.lines-->95,842<!--/N--> 行（含上面两个 `packages/` 文件夹），`apps/` 中 <!--N:top.apps.own.lines-->62,116<!--/N--> 行（含 cell），`deploy/` 中 <!--N:top.deploy.own.lines-->62,900<!--/N--> 行，`server/` 中 <!--N:top.server.own.lines-->23,420<!--/N--> 行，`mirror/` 中 <!--N:top.mirror.own.lines-->21,602<!--/N--> 行。有一个数据文件 `apps/web/public/app/auma/canon-v16.json` 就有 <!--N:biggest.lines-->29,509<!--/N--> 行，占本项目全部行数的 <!--N:biggest.pct-->10.7<!--/N-->%。

本项目自己的行数由这些构成：<!--N:kind.tests.pct-->33.6<!--/N-->% 是测试和测试夹具，<!--N:kind.data.pct-->11.6<!--/N-->% 是数据文件（`.json`、`.jsonl`），<!--N:kind.other.pct-->54.8<!--/N-->% 是代码、文档和配置。

这些代码做什么、如何测试，见 [`docs/WHAT-IS-BUILT.md`](WHAT-IS-BUILT.zh.md) 和 [`docs/ARCHITECTURE-ACTUAL.md`](ARCHITECTURE-ACTUAL.zh.md)。ball、organ、epoch 这类词在 [`docs/GLOSSARY.md`](GLOSSARY.zh.md) 中。

<a id="binary-files-without-source"></a>
## 没有源码的二进制文件

| 位置 | 文件数 | 许可 |
|---|---:|---|
| `apps/web/public/cells/*.wasm` | <!--N:prebuilt.cells.files-->24<!--/N--> | AGPL-3.0-or-later，附带 [`apps/web/public/cells/LICENSE.binaries`](../apps/web/public/cells/LICENSE.binaries) 中的未决问题 |
| `apps/web/public/seed-library/pentora/pentora36.wasm` | <!--N:prebuilt.pentora.files-->1<!--/N--> | 尚未授予任何许可：见它旁边的 [`LICENSE.binaries`](../apps/web/public/seed-library/pentora/LICENSE.binaries) |
| `apps/web/public/assets/stock-apps/dakini-code/assets/` | <!--N:prebuilt.dakini.files-->3<!--/N--> | AGPL-3.0-or-later，附带 [`LICENSE.binaries`](../apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries) 中的未决问题 |

AGPL 要求转交目标代码的人同时提供其源码。对这些文件，仅凭本仓库做不到这一点。它们旁边的说明写明了这一点，并写明在源码发布之前该怎么做。

## 按文件夹

按类别统计文件：

| 文件夹 | 全部文件 | 继承且未改动 | 继承，在此处改动 | 在此处新增 | 发布时写入 | Vendored | 二进制，没有源码 | 其他二进制 | 链接 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **整棵树** | <!--N:all.files-->21,044<!--/N--> | <!--N:all.unchanged.files-->19,873<!--/N--> | <!--N:all.changed.files-->180<!--/N--> | <!--N:all.added.files-->730<!--/N--> | <!--N:all.written.files-->65<!--/N--> | <!--N:all.vendored.files-->83<!--/N--> | <!--N:all.prebuilt.files-->28<!--/N--> | <!--N:all.binary.files-->71<!--/N--> | <!--N:all.link.files-->14<!--/N--> |
| 根目录下的文件 | <!--N:top.root.files-->50<!--/N--> | <!--N:top.root.unchanged.files-->34<!--/N--> | <!--N:top.root.changed.files-->5<!--/N--> | <!--N:top.root.added.files-->0<!--/N--> | <!--N:top.root.written.files-->10<!--/N--> | <!--N:top.root.vendored.files-->0<!--/N--> | <!--N:top.root.prebuilt.files-->0<!--/N--> | <!--N:top.root.binary.files-->0<!--/N--> | <!--N:top.root.link.files-->1<!--/N--> |
| `.agents/` | <!--N:top.dot-agents.files-->4,013<!--/N--> | <!--N:top.dot-agents.unchanged.files-->4,011<!--/N--> | <!--N:top.dot-agents.changed.files-->0<!--/N--> | <!--N:top.dot-agents.added.files-->0<!--/N--> | <!--N:top.dot-agents.written.files-->0<!--/N--> | <!--N:top.dot-agents.vendored.files-->0<!--/N--> | <!--N:top.dot-agents.prebuilt.files-->0<!--/N--> | <!--N:top.dot-agents.binary.files-->0<!--/N--> | <!--N:top.dot-agents.link.files-->2<!--/N--> |
| `.claude/` | <!--N:top.dot-claude.files-->1<!--/N--> | <!--N:top.dot-claude.unchanged.files-->0<!--/N--> | <!--N:top.dot-claude.changed.files-->0<!--/N--> | <!--N:top.dot-claude.added.files-->0<!--/N--> | <!--N:top.dot-claude.written.files-->0<!--/N--> | <!--N:top.dot-claude.vendored.files-->0<!--/N--> | <!--N:top.dot-claude.prebuilt.files-->0<!--/N--> | <!--N:top.dot-claude.binary.files-->0<!--/N--> | <!--N:top.dot-claude.link.files-->1<!--/N--> |
| `.github/` | <!--N:top.dot-github.files-->69<!--/N--> | <!--N:top.dot-github.unchanged.files-->61<!--/N--> | <!--N:top.dot-github.changed.files-->3<!--/N--> | <!--N:top.dot-github.added.files-->5<!--/N--> | <!--N:top.dot-github.written.files-->0<!--/N--> | <!--N:top.dot-github.vendored.files-->0<!--/N--> | <!--N:top.dot-github.prebuilt.files-->0<!--/N--> | <!--N:top.dot-github.binary.files-->0<!--/N--> | <!--N:top.dot-github.link.files-->0<!--/N--> |
| `LICENSES/` | <!--N:top.LICENSES.files-->6<!--/N--> | <!--N:top.LICENSES.unchanged.files-->0<!--/N--> | <!--N:top.LICENSES.changed.files-->0<!--/N--> | <!--N:top.LICENSES.added.files-->0<!--/N--> | <!--N:top.LICENSES.written.files-->6<!--/N--> | <!--N:top.LICENSES.vendored.files-->0<!--/N--> | <!--N:top.LICENSES.prebuilt.files-->0<!--/N--> | <!--N:top.LICENSES.binary.files-->0<!--/N--> | <!--N:top.LICENSES.link.files-->0<!--/N--> |
| `apps/` | <!--N:top.apps.files-->1,642<!--/N--> | <!--N:top.apps.unchanged.files-->1,491<!--/N--> | <!--N:top.apps.changed.files-->10<!--/N--> | <!--N:top.apps.added.files-->82<!--/N--> | <!--N:top.apps.written.files-->6<!--/N--> | <!--N:top.apps.vendored.files-->4<!--/N--> | <!--N:top.apps.prebuilt.files-->28<!--/N--> | <!--N:top.apps.binary.files-->20<!--/N--> | <!--N:top.apps.link.files-->1<!--/N--> |
| `benchmarks/` | <!--N:top.benchmarks.files-->48<!--/N--> | <!--N:top.benchmarks.unchanged.files-->48<!--/N--> | <!--N:top.benchmarks.changed.files-->0<!--/N--> | <!--N:top.benchmarks.added.files-->0<!--/N--> | <!--N:top.benchmarks.written.files-->0<!--/N--> | <!--N:top.benchmarks.vendored.files-->0<!--/N--> | <!--N:top.benchmarks.prebuilt.files-->0<!--/N--> | <!--N:top.benchmarks.binary.files-->0<!--/N--> | <!--N:top.benchmarks.link.files-->0<!--/N--> |
| `deploy/` | <!--N:top.deploy.files-->162<!--/N--> | <!--N:top.deploy.unchanged.files-->0<!--/N--> | <!--N:top.deploy.changed.files-->0<!--/N--> | <!--N:top.deploy.added.files-->155<!--/N--> | <!--N:top.deploy.written.files-->7<!--/N--> | <!--N:top.deploy.vendored.files-->0<!--/N--> | <!--N:top.deploy.prebuilt.files-->0<!--/N--> | <!--N:top.deploy.binary.files-->0<!--/N--> | <!--N:top.deploy.link.files-->0<!--/N--> |
| `docs/` | <!--N:top.docs.files-->1,020<!--/N--> | <!--N:top.docs.unchanged.files-->925<!--/N--> | <!--N:top.docs.changed.files-->6<!--/N--> | <!--N:top.docs.added.files-->53<!--/N--> | <!--N:top.docs.written.files-->32<!--/N--> | <!--N:top.docs.vendored.files-->0<!--/N--> | <!--N:top.docs.prebuilt.files-->0<!--/N--> | <!--N:top.docs.binary.files-->4<!--/N--> | <!--N:top.docs.link.files-->0<!--/N--> |
| `mirror/` | <!--N:top.mirror.files-->83<!--/N--> | <!--N:top.mirror.unchanged.files-->0<!--/N--> | <!--N:top.mirror.changed.files-->0<!--/N--> | <!--N:top.mirror.added.files-->80<!--/N--> | <!--N:top.mirror.written.files-->3<!--/N--> | <!--N:top.mirror.vendored.files-->0<!--/N--> | <!--N:top.mirror.prebuilt.files-->0<!--/N--> | <!--N:top.mirror.binary.files-->0<!--/N--> | <!--N:top.mirror.link.files-->0<!--/N--> |
| `native/` | <!--N:top.native.files-->79<!--/N--> | <!--N:top.native.unchanged.files-->79<!--/N--> | <!--N:top.native.changed.files-->0<!--/N--> | <!--N:top.native.added.files-->0<!--/N--> | <!--N:top.native.written.files-->0<!--/N--> | <!--N:top.native.vendored.files-->0<!--/N--> | <!--N:top.native.prebuilt.files-->0<!--/N--> | <!--N:top.native.binary.files-->0<!--/N--> | <!--N:top.native.link.files-->0<!--/N--> |
| `packages/` | <!--N:top.packages.files-->11,290<!--/N--> | <!--N:top.packages.unchanged.files-->10,814<!--/N--> | <!--N:top.packages.changed.files-->156<!--/N--> | <!--N:top.packages.added.files-->285<!--/N--> | <!--N:top.packages.written.files-->0<!--/N--> | <!--N:top.packages.vendored.files-->0<!--/N--> | <!--N:top.packages.prebuilt.files-->0<!--/N--> | <!--N:top.packages.binary.files-->34<!--/N--> | <!--N:top.packages.link.files-->1<!--/N--> |
| `patches/` | <!--N:top.patches.files-->12<!--/N--> | <!--N:top.patches.unchanged.files-->12<!--/N--> | <!--N:top.patches.changed.files-->0<!--/N--> | <!--N:top.patches.added.files-->0<!--/N--> | <!--N:top.patches.written.files-->0<!--/N--> | <!--N:top.patches.vendored.files-->0<!--/N--> | <!--N:top.patches.prebuilt.files-->0<!--/N--> | <!--N:top.patches.binary.files-->0<!--/N--> | <!--N:top.patches.link.files-->0<!--/N--> |
| `python/` | <!--N:top.python.files-->69<!--/N--> | <!--N:top.python.unchanged.files-->69<!--/N--> | <!--N:top.python.changed.files-->0<!--/N--> | <!--N:top.python.added.files-->0<!--/N--> | <!--N:top.python.written.files-->0<!--/N--> | <!--N:top.python.vendored.files-->0<!--/N--> | <!--N:top.python.prebuilt.files-->0<!--/N--> | <!--N:top.python.binary.files-->0<!--/N--> | <!--N:top.python.link.files-->0<!--/N--> |
| `scripts/` | <!--N:top.scripts.files-->451<!--/N--> | <!--N:top.scripts.unchanged.files-->444<!--/N--> | <!--N:top.scripts.changed.files-->0<!--/N--> | <!--N:top.scripts.added.files-->2<!--/N--> | <!--N:top.scripts.written.files-->1<!--/N--> | <!--N:top.scripts.vendored.files-->0<!--/N--> | <!--N:top.scripts.prebuilt.files-->0<!--/N--> | <!--N:top.scripts.binary.files-->4<!--/N--> | <!--N:top.scripts.link.files-->0<!--/N--> |
| `server/` | <!--N:top.server.files-->68<!--/N--> | <!--N:top.server.unchanged.files-->0<!--/N--> | <!--N:top.server.changed.files-->0<!--/N--> | <!--N:top.server.added.files-->68<!--/N--> | <!--N:top.server.written.files-->0<!--/N--> | <!--N:top.server.vendored.files-->0<!--/N--> | <!--N:top.server.prebuilt.files-->0<!--/N--> | <!--N:top.server.binary.files-->0<!--/N--> | <!--N:top.server.link.files-->0<!--/N--> |
| `snapshots/` | <!--N:top.snapshots.files-->1,864<!--/N--> | <!--N:top.snapshots.unchanged.files-->1,848<!--/N--> | <!--N:top.snapshots.changed.files-->0<!--/N--> | <!--N:top.snapshots.added.files-->0<!--/N--> | <!--N:top.snapshots.written.files-->0<!--/N--> | <!--N:top.snapshots.vendored.files-->0<!--/N--> | <!--N:top.snapshots.prebuilt.files-->0<!--/N--> | <!--N:top.snapshots.binary.files-->9<!--/N--> | <!--N:top.snapshots.link.files-->7<!--/N--> |
| `vendor/` | <!--N:top.vendor.files-->80<!--/N--> | <!--N:top.vendor.unchanged.files-->0<!--/N--> | <!--N:top.vendor.changed.files-->0<!--/N--> | <!--N:top.vendor.added.files-->0<!--/N--> | <!--N:top.vendor.written.files-->0<!--/N--> | <!--N:top.vendor.vendored.files-->79<!--/N--> | <!--N:top.vendor.prebuilt.files-->0<!--/N--> | <!--N:top.vendor.binary.files-->0<!--/N--> | <!--N:top.vendor.link.files-->1<!--/N--> |
| `website/` | <!--N:top.website.files-->37<!--/N--> | <!--N:top.website.unchanged.files-->37<!--/N--> | <!--N:top.website.changed.files-->0<!--/N--> | <!--N:top.website.added.files-->0<!--/N--> | <!--N:top.website.written.files-->0<!--/N--> | <!--N:top.website.vendored.files-->0<!--/N--> | <!--N:top.website.prebuilt.files-->0<!--/N--> | <!--N:top.website.binary.files-->0<!--/N--> | <!--N:top.website.link.files-->0<!--/N--> |

按类别统计文本行。vendor 代码和没有源码的预编译文件在两边都不计入，所以 `vendor/` 没有对应的行。`LICENSES/` 一行算作“发布时写入”，但这些许可文本是原样复制的第三方文本。

| 文件夹 | 文本行数（不含 vendored） | 继承且未改动 | 变动文件中的继承部分 | 在此处改动的行数 | 在此处新增 | 发布时写入 | 属于本项目的比例 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **整棵树** | <!--N:all.text.lines-->2,618,877<!--/N--> | <!--N:all.unchanged.lines-->2,214,212<!--/N--> | <!--N:all.changed.inherited-lines-->129,041<!--/N--> | <!--N:all.changed.own-lines-->6,042<!--/N--> | <!--N:all.added.lines-->261,690<!--/N--> | <!--N:all.written.lines-->7,892<!--/N--> | <!--N:all.own.pct-->10.5<!--/N-->% |
| 根目录下的文件 | <!--N:top.root.text.lines-->40,127<!--/N--> | <!--N:top.root.unchanged.lines-->3,457<!--/N--> | <!--N:top.root.changed.inherited-lines-->34,897<!--/N--> | <!--N:top.root.changed.own-lines-->311<!--/N--> | <!--N:top.root.added.lines-->0<!--/N--> | <!--N:top.root.written.lines-->1,462<!--/N--> | <!--N:top.root.own.pct-->4.4<!--/N-->% |
| `.agents/` | <!--N:top.dot-agents.text.lines-->167,515<!--/N--> | <!--N:top.dot-agents.unchanged.lines-->167,515<!--/N--> | <!--N:top.dot-agents.changed.inherited-lines-->0<!--/N--> | <!--N:top.dot-agents.changed.own-lines-->0<!--/N--> | <!--N:top.dot-agents.added.lines-->0<!--/N--> | <!--N:top.dot-agents.written.lines-->0<!--/N--> | <!--N:top.dot-agents.own.pct-->0.0<!--/N-->% |
| `.github/` | <!--N:top.dot-github.text.lines-->11,582<!--/N--> | <!--N:top.dot-github.unchanged.lines-->10,272<!--/N--> | <!--N:top.dot-github.changed.inherited-lines-->211<!--/N--> | <!--N:top.dot-github.changed.own-lines-->26<!--/N--> | <!--N:top.dot-github.added.lines-->1,073<!--/N--> | <!--N:top.dot-github.written.lines-->0<!--/N--> | <!--N:top.dot-github.own.pct-->9.5<!--/N-->% |
| `LICENSES/` | <!--N:top.LICENSES.text.lines-->323<!--/N--> | <!--N:top.LICENSES.unchanged.lines-->0<!--/N--> | <!--N:top.LICENSES.changed.inherited-lines-->0<!--/N--> | <!--N:top.LICENSES.changed.own-lines-->0<!--/N--> | <!--N:top.LICENSES.added.lines-->0<!--/N--> | <!--N:top.LICENSES.written.lines-->323<!--/N--> | <!--N:top.LICENSES.own.pct-->100.0<!--/N-->% |
| `apps/` | <!--N:top.apps.text.lines-->237,689<!--/N--> | <!--N:top.apps.unchanged.lines-->173,226<!--/N--> | <!--N:top.apps.changed.inherited-lines-->2,347<!--/N--> | <!--N:top.apps.changed.own-lines-->238<!--/N--> | <!--N:top.apps.added.lines-->61,259<!--/N--> | <!--N:top.apps.written.lines-->619<!--/N--> | <!--N:top.apps.own.pct-->26.1<!--/N-->% |
| `benchmarks/` | <!--N:top.benchmarks.text.lines-->6,458<!--/N--> | <!--N:top.benchmarks.unchanged.lines-->6,458<!--/N--> | <!--N:top.benchmarks.changed.inherited-lines-->0<!--/N--> | <!--N:top.benchmarks.changed.own-lines-->0<!--/N--> | <!--N:top.benchmarks.added.lines-->0<!--/N--> | <!--N:top.benchmarks.written.lines-->0<!--/N--> | <!--N:top.benchmarks.own.pct-->0.0<!--/N-->% |
| `deploy/` | <!--N:top.deploy.text.lines-->62,900<!--/N--> | <!--N:top.deploy.unchanged.lines-->0<!--/N--> | <!--N:top.deploy.changed.inherited-lines-->0<!--/N--> | <!--N:top.deploy.changed.own-lines-->0<!--/N--> | <!--N:top.deploy.added.lines-->62,625<!--/N--> | <!--N:top.deploy.written.lines-->275<!--/N--> | <!--N:top.deploy.own.pct-->100.0<!--/N-->% |
| `docs/` | <!--N:top.docs.text.lines-->200,459<!--/N--> | <!--N:top.docs.unchanged.lines-->170,395<!--/N--> | <!--N:top.docs.changed.inherited-lines-->24,298<!--/N--> | <!--N:top.docs.changed.own-lines-->380<!--/N--> | <!--N:top.docs.added.lines-->1,759<!--/N--> | <!--N:top.docs.written.lines-->3,627<!--/N--> | <!--N:top.docs.own.pct-->2.9<!--/N-->% |
| `mirror/` | <!--N:top.mirror.text.lines-->21,602<!--/N--> | <!--N:top.mirror.unchanged.lines-->0<!--/N--> | <!--N:top.mirror.changed.inherited-lines-->0<!--/N--> | <!--N:top.mirror.changed.own-lines-->0<!--/N--> | <!--N:top.mirror.added.lines-->20,300<!--/N--> | <!--N:top.mirror.written.lines-->1,302<!--/N--> | <!--N:top.mirror.own.pct-->100.0<!--/N-->% |
| `native/` | <!--N:top.native.text.lines-->4,012<!--/N--> | <!--N:top.native.unchanged.lines-->4,012<!--/N--> | <!--N:top.native.changed.inherited-lines-->0<!--/N--> | <!--N:top.native.changed.own-lines-->0<!--/N--> | <!--N:top.native.added.lines-->0<!--/N--> | <!--N:top.native.written.lines-->0<!--/N--> | <!--N:top.native.own.pct-->0.0<!--/N-->% |
| `packages/` | <!--N:top.packages.text.lines-->1,591,043<!--/N--> | <!--N:top.packages.unchanged.lines-->1,427,913<!--/N--> | <!--N:top.packages.changed.inherited-lines-->67,288<!--/N--> | <!--N:top.packages.changed.own-lines-->5,087<!--/N--> | <!--N:top.packages.added.lines-->90,755<!--/N--> | <!--N:top.packages.written.lines-->0<!--/N--> | <!--N:top.packages.own.pct-->6.0<!--/N-->% |
| `patches/` | <!--N:top.patches.text.lines-->1,816<!--/N--> | <!--N:top.patches.unchanged.lines-->1,816<!--/N--> | <!--N:top.patches.changed.inherited-lines-->0<!--/N--> | <!--N:top.patches.changed.own-lines-->0<!--/N--> | <!--N:top.patches.added.lines-->0<!--/N--> | <!--N:top.patches.written.lines-->0<!--/N--> | <!--N:top.patches.own.pct-->0.0<!--/N-->% |
| `python/` | <!--N:top.python.text.lines-->10,728<!--/N--> | <!--N:top.python.unchanged.lines-->10,728<!--/N--> | <!--N:top.python.changed.inherited-lines-->0<!--/N--> | <!--N:top.python.changed.own-lines-->0<!--/N--> | <!--N:top.python.added.lines-->0<!--/N--> | <!--N:top.python.written.lines-->0<!--/N--> | <!--N:top.python.own.pct-->0.0<!--/N-->% |
| `scripts/` | <!--N:top.scripts.text.lines-->111,859<!--/N--> | <!--N:top.scripts.unchanged.lines-->111,076<!--/N--> | <!--N:top.scripts.changed.inherited-lines-->0<!--/N--> | <!--N:top.scripts.changed.own-lines-->0<!--/N--> | <!--N:top.scripts.added.lines-->499<!--/N--> | <!--N:top.scripts.written.lines-->284<!--/N--> | <!--N:top.scripts.own.pct-->0.7<!--/N-->% |
| `server/` | <!--N:top.server.text.lines-->23,420<!--/N--> | <!--N:top.server.unchanged.lines-->0<!--/N--> | <!--N:top.server.changed.inherited-lines-->0<!--/N--> | <!--N:top.server.changed.own-lines-->0<!--/N--> | <!--N:top.server.added.lines-->23,420<!--/N--> | <!--N:top.server.written.lines-->0<!--/N--> | <!--N:top.server.own.pct-->100.0<!--/N-->% |
| `snapshots/` | <!--N:top.snapshots.text.lines-->123,282<!--/N--> | <!--N:top.snapshots.unchanged.lines-->123,282<!--/N--> | <!--N:top.snapshots.changed.inherited-lines-->0<!--/N--> | <!--N:top.snapshots.changed.own-lines-->0<!--/N--> | <!--N:top.snapshots.added.lines-->0<!--/N--> | <!--N:top.snapshots.written.lines-->0<!--/N--> | <!--N:top.snapshots.own.pct-->0.0<!--/N-->% |
| `website/` | <!--N:top.website.text.lines-->4,062<!--/N--> | <!--N:top.website.unchanged.lines-->4,062<!--/N--> | <!--N:top.website.changed.inherited-lines-->0<!--/N--> | <!--N:top.website.changed.own-lines-->0<!--/N--> | <!--N:top.website.added.lines-->0<!--/N--> | <!--N:top.website.written.lines-->0<!--/N--> | <!--N:top.website.own.pct-->0.0<!--/N-->% |

<a id="how-it-was-counted"></a>
## 统计方法

发布前最后一次提交中的每个文件，都按其 git blob id（文件字节的哈希）与上游起点做了比较。发布时改写或写入的文件，按那次提交归类。

- **继承且未改动**：路径相同、字节相同，与起点一致。
- **继承，在此处改动**：路径相同，字节不同。“此处改动的行数”是 git 报告的、该文件从起点到发布前最后一次提交之间插入的行数。文件的其余部分算作继承。
- **在此处新增**：路径不在起点中。每一行都算本项目的。新增的文件仍可能含有第三方代码；例如 [`apps/web/public/app/assets/AURA-TRACE-THIRD-PARTY.txt`](../apps/web/public/app/assets/AURA-TRACE-THIRD-PARTY.txt) 就列出了一些。
- **发布时写入**：生成这棵公开树的脚本自己写下的文件：许可文本、声明、前页和一个全新节点的起始记录。
- **Vendored**：`vendor/` 下的全部内容，加上 `apps/web/public/app/assets/` 中的 <!--N:vendored.outside-vendor.files-->4<!--/N--> 个第三方音频编解码器文件，每个都在 [`SOURCES.json`](../apps/web/public/app/assets/SOURCES.json) 中按名称列出或按哈希匹配。
- **二进制，没有源码**：在 `LICENSE.binaries` 说明中列出的文件。`aura-focus.wasm` 不属于这一类，因为它的源码 `aura-focus.wat` 就在旁边。
- **其他二进制**：含有空字节或不是 UTF-8 文本的文件，例如图片。
- **行数**是文件在这棵树中的物理行数。对最后一行没有换行符的文件，`wc -l` 可能少算一行。**代码**指扩展名为 `.ts .tsx .mts .cts .js .jsx .mjs .cjs .py .rs .go .c .h .cpp .sh .wat .css .html .swift .rb` 的文件。

会改变数字的选择，在此说明，方便你权衡：

- 这棵树发布时，<!--N:pub.rewritten.files-->72<!--/N--> 个继承文件（<!--N:pub.rewritten.lines-->13,881<!--/N--> 行）中的名称、链接和占位符被替换过。它们仍算作继承且未改动。
- 不追踪移动的文件：一次移动算作一个被删除的路径和一个新增的路径。在默认相似度下，git 在这两次提交之间找到 <!--N:method.renames-->0<!--/N--> 次重命名，所以目前这不会改变任何数字。
- 这些统计已与 git 自己对同样两次提交给出的新增路径和修改路径总数核对过，二者一致。
- 私有节点中被留在这棵树之外的文件（它的数据、密钥、名称和历史），本页的任何地方都没有统计。

这些数字没有说明的事：一行是谁或什么写的，它好不好，它是否被使用或被测试。

<a id="what-you-can-reproduce"></a>
## 你可以复现什么

仅凭这棵树，你可以核对每个文件夹的文件数和文本行数、没有源码的二进制文件清单（`LICENSE.binaries` 说明），以及 vendored 清单（[`vendor/README.md`](../vendor/README.md)、[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)）。

有了上游项目的克隆，你可以近似还原这一划分。这棵树写明了它的地址 `https://github.com/deepseek-ai/deepseek-harness`，例如在 `native/system/packages/entry/package.json` 中。把每个文件的 blob id（`git hash-object <file>`）与上游某次提交中同一路径的文件比较。有两点限制。这棵树没有记录本项目从上游哪次提交起步，所以要选出字节完全一致的文件最多的那次提交。而且你得到的“改动”数会比这里的高，因为它还包括了发布时改写的文件，以及发布时写入、路径在上游也存在的文件。这个公开方法尚未对真实的上游仓库运行过：UNVERIFIED。

你无法复现的是：上面的确切划分。它取决于本项目发布前的历史，这段历史并未公开。
