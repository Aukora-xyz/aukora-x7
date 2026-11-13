---
description: "面向构建或排查实验性 Web 预览运行时的维护者，说明浏览器 worker 中的 harness 托管。"
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-runtime`

[English](README.md) | 中文

## 概述

浏览器 worker 宿主：整棵 harness 插件树跑在一个 dedicated Web Worker 里，用于预览部署与打包回归（[实验组](../README.zh.md)）。worker 边下载边解压打包好的 VFS 镜像并挂载进内存，经 CommonJS 包装加载器装载模块，并通过一条讲纯 HTTP 的 postMessage 隧道服务页面。当预览需要在没有 Node 宿主的环境中运行已打包 harness 时，请使用它。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

公开 npm 包在根入口导出运行时库，通过 `./worker` 提供自包含的浏览器 Worker，通过 `./client` 提供页面连接器。部署方通过 [打包器](../webworker-packer/README.zh.md) 单独提供和托管 VFS 镜像；安装此库不会增加 profile 层。根入口还导出打包器所用的模块代理表与替换表。

一条 tsdown 管线产出三个构建产物；另有一层由源码维护的进程实现：

- **`lib/index.js`（装配库）**——`createWorkerHost`/`startWorkerHost` 挂载基础镜像和按序排列的数据 overlays（`storage/`）、登记镜像的懒加载归档、安装模块加载器（`module-system/`）与 `process` shim、经镜像自带的 `dsh-app-boot` 启动插件树，并把服务 seam 交给隧道。Overlay 只能替换 `home/` 与 `workspace/` 下的文件，不能替换基础 manifest 或模块。镜像布局契约（`image-layout.ts`：虚拟根、manifest 路径、懒加载归档目录、空目录）与 manifest（`image-manifest.ts`：profile、安装清单、`lowered` 包装契约门、懒加载归档）与 packer 共享。Worker 按启动器的方式启动 manifest 指定的随附 profile：镜像里的 app-boot 用随附模板初始化 `home/profiles/<profile>/`，从镜像单独携带的安装 manifest 解析 bundle，并合成各 bundle 层、profile patch 与 home patch。profile 上下文、启动环境快照，以及不带运行时 resolution 的 `PluginPackages` 服务都按启动器的方式提供；模块解析由 Worker 加载器负责。profile 上下文不带命令行 overlay；packer 按 `PLATFORM_ENTRY_CONFIG` 写入镜像的 home patch（`home/cordis.patch.yml`），使 JSONL Session 日志保持明文。ConfigEditor 将覆盖值持久化到 profile patch，协调每次写入，Loader 提交实时值。Worker 在隧道开始服务后提交 `appReady`，因此 HMR 可以加载 profile 变更并实时应用；Worker 的 ES module 缓存始终为空，`process` shim 也不报告入口脚本，因此 HMR 不比较、也不替换已加载的模块。插件管理可以列出并开关安装提供的 optional bundle，其包操作会因 `execa` 拒绝而失败。配置修改在当前 Worker 生命周期内有效。
- **懒加载归档**——manifest 按路径和大小登记 packer 移出基础镜像的每个页面 chunk，并给出相对镜像 URL 的归档名。存在性、stat 和目录列表立即作答；第一次异步读取（`fs.promises.readFile`、`fs.promises.open`、`fs.createReadStream`、`fs.promises.cp`）为所有等待中的读取方只拉取并解压一次该归档，按登记内容校验后挂载其文件，不发布 mutation。拉取失败时本次读取被拒绝，文件保持登记状态，下次读取会重新拉取。在此之前，对已登记文件的同步读取、写入、追加、截断、chmod、rename 和 link 会以 `ERR_DSH_VFS_DEFERRED` 失败，错误中写明归档名；unlink 和递归删除会移除登记，再次 seed 该路径会替换登记。归档名由内容摘要派生，拉取时只校验登记的路径和大小，不校验摘要。登记了懒加载归档的镜像必须以 URL 传入。
- **`lib/worker.js`（worker 束）**——装配库加本包的 Node 兼容层，合成一个自含 ES module。模块代理表（`module-proxies.ts`）是唯一平台叉口：`node:*` 内建走 VFS、隧道和浏览器原语，浏览器做不到的走结构化 stub（调用即在 console 报错并抛出），native/binary 包则替换执行后端。`node:module` 在镜像 package 根之上提供 `createRequire().resolve` 与 `.resolve.paths()`，使未修改的包无需执行目标模块即可发现 manifest。`node-addon-require-builtin` 应答 vendor Loader、app-boot 和 HMR 在没有 `--expose-internals` 时读取的 Node v24.18.0 internal 模块：cascaded ESM loader 的 `resolveSync` 和 `import` 经 Worker 加载器完成，失败时带 Node 的 `ERR_MODULE_NOT_FOUND` 与 `ERR_PACKAGE_PATH_NOT_EXPORTED` 错误码，`loadCache` 为空；HMR 会替换的 CommonJS loader、package reader、`modules` binding 与 resolve cache 成员被调用时拒绝。`process.versions.node` 报告 `24.18.0`，因此 `ModuleLoader.fromInternal()` 和 Loader 的 `internal` 拿到的是这个 cascaded loader。`node:path.win32.isAbsolute` 与 `node:util.inherits` 与 Node 一致，其余 `win32` 成员抛出。`node:util` 的 JSON 数据比较器检查可枚举的自有属性，使 `__proto__` 等记录字段的准入判定与 Node 一致。全局 `process` shim 带有包括 `title` 在内的 Node 环境识别字段，避免 Worker 执行误入仅适用于 DOM 的分支；镜像中加载的包通过 Node 的 `global` 别名访问同一个 `globalThis` 对象。pack 期解析器会把名称静态可知的模块请求报告给 packer 的可达性遍历，其中包括通过 `node:module` 或 `module` 具名导入在模块作用域直接发起的 `createRequire(import.meta.url)('pkg')` 调用。保存、经 CommonJS 获取或另设基准的 `createRequire` 调用需要镜像入口种子。降低后的模块体在每次引用具名导入与 default 导入时，都经所 require 的模块对象读取，因此循环导入中的模块能在导出方完成初始化后读到该绑定；在含此类导入的模块中，对导入绑定赋值、直接调用 `eval`、声明使用保留前缀 `__dsh$` 的名字，都会使 pack 失败。VFS mutation 驱动 `node:fs` 的 callback、polling 和 promise watcher，监听回调运行在创建 watcher 时的异步上下文中，而不是写入方代码的上下文中；打开的 descriptor 在 rename、replacement 和 unlink 后仍保留文件身份与访问模式，只要文件名仍指向该文件，`FileHandle.stat({ bigint: true })` 报告的 device 与 inode 身份就与路径 stat 相同，`FileHandle.chmod()` 则更新打开文件身份的权限；`readable-stream` 提供 `node:stream/promises` 的完成等待与管道方法，以及文件流以及 Chokidar、readdirp 等未修改镜像包所用的流状态机。维护中的 `string_decoder` 包提供 `node:string_decoder`，在数据块之间保留不完整的多字节字符。AsyncLocalStorage 经 pack 时降低注入的 snapshot/restore 面在 `await` 间携带同步栈因果。worker 不带编译器：packer 未降低的镜像在挂载时被拒。回调式 `fs.realpath.native` 别名在已挂载的 VFS 内解析路径，并支持 `util.promisify`。
- **`src/shell/`（worker 自己的进程层）**——浏览器 worker 无法 fork，所以 `node:child_process` 不是 stub 而是实现：`spawn` 把命令放进它自己的 Web Worker——就是这同一个束，由首帧告诉它「你是 shell 进程」——并以 subprocess 服务消费的 `ChildProcess` 面报告结果。命令不占宿主线程，`SIGKILL` 不管它在干什么都能终止它，而它只能靠消息触达 VFS（由宿主应答这些帧）。Worker 平台 executable 在不替换 JavaScript 包、也不把具体实现耦合进 `node:child_process` 的情况下保持 Landlock 等 native 包协议；`xdg-open` 把一个 VFS 文本文件交给页面的只读查看器，因此 **打开配置文件** 等桌面打开操作会在页面内显示该文件；普通命令使用本包的求值器与 coreutils 命令表。语法来自 `@yarnpkg/parsers` 的 `parseShell`，而 `execSync`/`fork` 依然拒绝，因为它们需要真进程。
- **`lib/client.js`（页面半）**——启动分为相互独立的两段。`chooseWorkerHostSource({ image?, fixtureManifest? })` 可选地拥有 boot barrier 与 fixture manifest：没有 `preview-fixture` 时停在来源选择面板，合法 query 则直接选择；两条路径都返回按序排列的 overlays。`connectWorkerHost(worker, { image?, overlays? })` 仍是公开的基础运行态连接器；调用方跳过选择器时 overlay 列表为空。`apps/web` 调用这两段并提供静态打包的 Worker。开局 `init` 帧携带基础镜像与按序排列的 overlay URL，boot 载荷送达结构化 index 注入表，`applyIndexInjections` 在壳入口运行前逐行执行。脚本 preload 行只是提示，因此会被跳过：`/plugins` 资源只能经 tunnel 解析，`loadBundle` 会在首次需要时获取 combo、把仅 tunnel 可达的 sourcemap 内嵌为 Base64 data URL，再以 Blob 执行脚本。在 shell 入口运行之前，页面读取 `GET /__assets__`（隧道以镜像中所有包资源组成的未压缩 tar 回答），并提供 `resolveAsset`，把 bundle 传给 `require.asset` 的每个 `plugins/<package>/assets/<path>` 引用映射为这些字节的 Blob URL。worker 主动发出的 `view-text` 帧会打开页面的模态文本查看器。Tunnel 还暴露 fetch 形式的传输、独立文件上传载体和 API 客户端。请求帧通过结构化克隆保留 Blob 请求体，并转移 `ReadableStream<Uint8Array>` 的所有权。Host Worker 将两种请求体都逐块送入路由，因此通用文件上传不会在任何浏览器线程创建完整字节数组。Remote 流的上行以 `stream-uplink-item` / `stream-uplink-end` 帧进入没有上限的 `TunnelUplink`，`end` 之后到达的项被丢弃：页面与其 worker 是同一个可信的同源边界，Host 的 inbox 上限在此不适用。

在显式根上下文中登记的回调和定时器保留其空 store，避免继承无关事务。

验收在 `apps/web/tests/preview-boot.e2e.ts`：静态服务真实构建页面，在 headless Chromium 里驱动 pre-boot 选择面板与 Worker 激活。空白选择验证首次启动；`vfs-example` overlay 提供普通 workspace 文件与明文 persistence 产物，无需模型请求即可验证 Workspace/Session 冷发现、工具呈现、subagent 导航和历史分页。showcase 混排空字符串、纯空白与非空推理块，并包含多行长命令和父路径文件链接；这些是人工构造的 fixture，不是真实模型输出。另一个根 Session `preview-turn-spacing` 含三个多步骤轮次，其正文用于对照收紧后的过程行间距与回复间距。[打包器](../webworker-packer/README.zh.md)在 Node 中根据已提交的历史日志准备当前代后继文件；这些源日志在 overlay 中逐字节保持不变。fixture 生成器负责验收测试的当前投影缓存。选择面板为 WebFS 保留独立的用户授权来源；该 provider 不读取内置 fixture。

[已构建 bundle 导入检查](tests/compile/transform-corpus-check.ts)在库构建后检查裸 Node 导入。Dockkit 例外接受 Node 针对任意样式表报告的未知 `.css` 扩展名错误，而不限定某一固定路径；其他扩展名、错误码或消息，以及意外成功的豁免导入，仍然报错。

-----

<a id="model-experience"></a>
## Wasm cell 执行

`createCellHost` 保留已准入的模块，并通过一个专用执行 worker 串行执行调用。每个 ABI 导出都获得一份新的、有上限的 fuel 配额。独立的 5000 ms 期限覆盖 worker 启动、Wasm 实例／start 执行、ABI 验证、分配、执行和 fuel 检查。超时会返回 `TIMEOUT`，终止 worker 并丢弃其所有实例；后续调用会使用已准入的模块重新创建 worker。排队中的调用和独立的获取／准入阶段不计入该执行期限。`dispose()` 会停止进行中的工作，结算排队调用，并永久关闭 host。

浏览器需要支持嵌套 worker，并允许执行 `blob:` worker。不具备该能力的 host 必须通过 `createWorker` 提供真正独立的 worker 传输；没有同步回退。worker 创建或执行失败会返回 `CELL_WORKER_UNAVAILABLE` 或 `CELL_WORKER_FAILED`。此隔离覆盖 Wasm cell，不覆盖任意 organ JavaScript。

使用 `cellCanonicalJson` 的 Microverse 请求和回执序列化只接受安全整数，在任意嵌套深度都会拒绝小数、非有限数和不安全整数。返回的 JSON 结果保留有限浮点数，以兼容消费方；调用方不得使用仅支持整数的序列化器处理任意浮点应用输出。固定项和 ABI 导出要求保持不变。

## 模型体验

无：本包只在浏览器 worker 里承载插件树并应答它的 `node:*` 调用；面向模型的注册与请求组装属于它启动的那些插件。

#### KV Cache 影响

无：浏览器传输自身不增加缓存，请求缓存字段仍由配置的提供方插件负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **worker 组合写明文会话日志**（镜像 home patch 中的 `compression: 'none'`；ConfigEditor 会拒绝修改这一行的配置）：不带 Zstandard 编解码器，导出日志是 `.jsonl`，不会是 `.jsonl.zstd`。
- **Aukora 云备份在发送快照前重新检查本地写入者**：只读状态或 IndexedDB 写入者 epoch 变化会阻止发布；无法读取 epoch 时报告备份失败。此本地检查无法撤回已经发送的请求，也不能使本地 epoch 与边缘快照成为原子操作。
- **成功的云响应必须提供可用的快照标识**，来源是 ETag 响应头或 JSON 正文。没有标识时，结果保持未知，自动上传暂停至重新加载；待保存修改和先前的本地父快照记录保持不变。上传 promise 完成不代表已验证保存。
- **`node:dns/promises`、`node:vm`、`node:repl`、`node:net`、`node:sqlite`、`node:worker_threads` 是结构化 stub**：镜像打包可以解析这些导入；每个已暴露的调用都在 console 报告拒绝，并抛出带 Node `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 错误码的错误。需要原生 DNS、真进程、Node REPL 或真 realm 隔离的行在此无法运行。
- **`node:assert/strict` 仅支持真值断言**：对于假值，可调用的默认导出和 `ok` 使用传入的消息或通用文本抛出 `ERR_ASSERTION`，或原样抛出传入的 Error。其他断言 API 未提供。
- **原生 TLS 监听器需要 Node Host**：worker 的 `node:https.createServer` 会拒绝激活，不会替换成明文。预览内部的 HTTP 隧道不绑定套接字；面向浏览器的 HTTPS 由部署服务器提供。
- **桌面产品埋点不可用**：`got.post` 明确报告 worker host 不支持该调用。浏览器镜像不包含 Got 及其 Node HTTP 依赖；预览组合不启用桌面上报。
- **宿主包管理命令不可用**：`execa` 明确报告 worker host 不支持该调用；预览无法运行 pnpm、安装插件或安装原生依赖。
- **Pi Agent 执行不可用**：`@earendil-works/pi-coding-agent` 替代模块允许元数据导入，并以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 拒绝 SDK 调用。镜像不包含其原生 CLI 与终端 UI 依赖。原生 DSH 仍保留完整的 OAR 运行时注册表。
- **pi-ai 模型请求仅限 Moonshot AI 与 DeepSeek chat completions**：替代实现携带 `moonshotai`（`https://api.moonshot.ai/v1`）、`moonshotai-cn`（`https://api.moonshot.cn/v1`）与 `deepseek`（`https://api.deepseek.com`）的已安装模型目录，通过现有设置和凭据路径使用浏览器 `fetch` 流式请求。其他提供方和协议仍明确报告 worker host 不支持；提供方访问仍取决于浏览器 CORS 与部署策略。
- **PTC Node 程序不可用**：process shim 用 `/dsh/bin/node` 表示可执行文件身份，使 provider 能够激活，但 Worker 既没有 Node 可执行文件，也没有 `stripTypeScriptTypes`。程序执行会在启动子进程前失败。
- **Office 转换需要 Node Host**：LibreOffice kit 的替代模块以 `unavailable` 拒绝创建转换器。浏览器镜像排除 kit 及其引擎依赖；Office 预览提示转换不可用。
- **模块重新加载不等于传递式 HMR**：Worker 的 ES module 缓存始终为空，但其自有 loader 仅在存储字节与成功求值时一致时，才复用规范化 VFS 路径的导出。JS/JSON 文件更改后，下次直接 `require` 或导入会重新加载；尚在求值的 CommonJS 循环保留部分导出。已缓存的导入方和包解析元数据需要明确逐出缓存或重新加载；已持有的引用不会被替换。preview 镜像不会修改模块文件：包操作会因 `execa` 拒绝而失败。
- **球路径要求字节匹配**：执行或复用缓存前，loader 对规范的 `<root>/home/balls/<64-lowercase-sha256>.js` 路径验证存储的原始字节，包括绝对路径、相对路径、文件 URL 和包解析的别名。不匹配时抛出 `Ball integrity check failed`。恢复原始字节，或使用内容对应的新哈希与路径。显式 `ball:<sha256>` 导入仍每次重新求值。
- **Worker `node` 的生命周期有界**：直接注入的 timeout、interval 和 immediate 句柄会使命令保持运行，并在完成、退出、出错或达到 30 秒期限时清理。返回的 Promise 也受同一期限约束；超时返回非零退出状态。被 require 的模块中的定时器、`globalThis` 定时器及外部 worker 不受跟踪或取消。应显式返回这些工作的完成 Promise；宿主 worker 中的同步循环仍无法抢占。
- **Node internal 模块只提供 HMR 会替换的成员**：CommonJS loader、package reader、`modules` binding 与 `getOrCreateModuleJob` 被调用时拒绝；Worker 自己的 `require` 不经过 CommonJS loader，因此替换 `Module._resolveFilename` 或 `Module._load` 不会改变 Worker 的解析。
- **CommonJS 的 `require('stream')` 返回模块命名空间，而不是 Node 的 `Stream` 构造函数**：把它传给 `util.inherits` 的代码会在加载时失败。
- **懒加载提供的文件在其归档到达前不能同步读取**：使用方必须先异步读取一次；Host 的按需 Client chunk 路由就是这样做的。
- **文件 watcher 只能观察已挂载的 VFS**：镜像 seed 不产生事件，VFS 也没有符号链接或外部写入方。`persistent`、`ref()` 和 `unref()` 保留 Node API，但浏览器没有引用计数事件循环，因此这些接口不能控制 dedicated Worker 的生存期。
- **Worker confinement 是 VFS 边界，不是内核 Landlock**：`read-only` 和 `workspace-write` 运行未经修改的 `@deepseek-ai/node-addon-system/landlock-run` JavaScript 与 launcher argv，进程层则实现逻辑 `landlock-run` 可执行文件，并在 shell 的每次文件系统请求上执行其授权。`full` 仅覆盖 Worker 命令表和已挂载 VFS，不表示能够执行任意 native 进程，也不表示 Linux 内核隔离。
- **worker 束钉住了 `@yarnpkg/parsers` 的包内路径**——构建解析到该包自己的 `lib/shell.js` 而非包根，因为包根 barrel 还 re-export 了 Syml 解析器，会把 js-yaml 拖进一个从不解析该格式的束（约 175 kB，外加 worker 启动时的模块体求值）。该路径由包 manifest 派生，包内布局一变即构建期失败、不会静默退回 barrel；升级这个依赖时须复核 shell 解析器是否仍在那里。
- **这个 shell 不是 bash**：没有循环、函数、`case`、作业控制或进程替换——语法止步于管道、`&&`/`||`、子 shell、group、重定向与展开。`&` 会就地把命令跑完，`sed` 只接受替换脚本，模式是 JavaScript 正则，命令表只有 coreutils（没有 `git`，没有网络工具）。
- **shell 进程没有同步文件面**：它靠消息读写宿主的 VFS，因为阻塞等待回帧需要 `SharedArrayBuffer`，而那要求 GitHub Pages 给不了的跨源隔离。因此目录遍历类命令每个条目一次往返，并发的两条命令写入可以交错。
- **transport、worker-host、页面半的覆盖需要浏览器级 harness**——这些模块未达 per-file 覆盖门；单测覆盖 storage、ALS、transform 与 stub 契约。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

## X6.1 本地运行时

`tree_undo` 当前因没有可执行的准入签发器而以 `PEARL_QUALIFICATION_MISSING_OR_STALE` 拒绝；这不是 patch 资格过期。底层 `tree_patch` 和 `tree_undo` 串行执行变更，并完整保留此前的模块、配置和禁用状态，包括仅配置发生变化的情况。可选的 `expectedEpoch` 和 `expectedBallId` 在取得变更队列后检查。旧的仅含 specifier 的历史仍会保留，但 undo 不会猜测缺失的配置；此时应改为恢复完整快照。变更前的快照失败会阻止编辑。

变更结果和 `body_map` 分别提供独立的 `prepared`、`activated`、`localSaved`、`remoteSaved` 和 `receiptSaved` 字段。本地保存会等待 IndexedDB 事务；失败时保留脏路径。远程保存仅表示具名 `remoteTarget` 端点确认了精确的 manifest，不表示 Cloudflare 备份或 GitHub 发布。每次已提交的 patch 和 undo 都会向现有回执链追加记录；只有本地持久化成功后，才会报告回执已保存。

本地 host 通过一个串行化 HTTP/WebSocket 发布器负责选择 manifest。新 HEAD 必须具有所选父级和 epoch、有效的 manifest 与模块 hash，以及可用的历史模块。重放已选 manifest 是幂等的。竞争提案会保留在私有镜像的 `balls/forks/` 目录中，并返回 `REBASE_REQUIRED`。VFS 增量和快照上传不能覆盖 HEAD 或不可变模块存储。

快照和暂存父 head 的验证接受旧式 manifest ID，以及绑定除 `ballId` 外所有自身字段的规范 ID。`tree_patch` 新构造的治理候选项使用规范 ID，在所有者批准和主机准入之前保持未激活；现有暂存候选项不会被改写。普通候选项保留现有 ID 和资格策略。采用规范 head 前应加载兼容运行时；旧 bundle 可能拒绝其快照。默认 edge 的仅 passkey 策略要求仅一个治理条目改变且其他条目保持不变，不证明行为保持测试通过。

`ball_put` 只暂存不可变代码和元数据。树编辑才会选择模块。启动会采用 host 的精确选择，并把不同的本地 HEAD 保留为 fork；发生变化的 Seed 源码通过 `seedCandidates` 展示，不会静默改写选择。对等端通知在 host 确认后发送，接收标签页会先确认 host 的选择，再进行协调。协调失败会恢复此前条目，不会发布失败的目标。快照恢复会推进 HEAD 的 epoch，而不是倒退历史。

回执验证会重新计算每个检查点封装记录的 hash，并验证回执数量、序列、覆盖的最后一条回执、Merkle 根、签名和签名者连续性。独立提供的公钥或现有本地密钥用于锚定身份；没有密钥时，结果会明确表示仅检查了链一致性。已有检查点时，损坏或缺失的签名身份绝不会被静默重新生成。签名密钥保留在本地 IndexedDB 中，不会进入增量或快照导出载荷。

Scion 在独立、可销毁的浏览器 worker 中编译显式的多文件 TypeScript/ESM organ 快照。其离线 esbuild-wasm 0.28.2 产物在初始化前，会按源码固定的大小和 SHA-256 进行检查。输入上限为 128 个文件和 2 MiB，导入只在该快照内或 host 拥有的精确外部列表中解析，父级会在截止时间终止 worker。结果包含编译器固定信息、源码／构建配方根值和输出摘要。编译和 `ball_put` 只暂存尚未执行的源码，不执行或选择它。激活仍在主运行时中执行所选 organ，不是隔离试运行。Scion 的浏览器端运行时闭包编译器及其发布晋升操作仍明确不可用；下述 host 捕获和运行时选择是独立功能。

`scion_grow` 将类型化编译接入现有的实时 Seed 生长周期。提供具名 Seed organ、最多 127 个源文件以及显式验收用例；生成的入口会在注册前验证导出的 organ 名称，并计入编译器输入／输出 hash。用例在编译前冻结并计算 hash，最多 32 个、合计不超过 64 KiB，每个用例必须且只能指定预期结果或预期错误。生长要求本地准备已确认、所选 HEAD 未变化且存储可写。现有周期执行实时安装、验收以及拒绝／undo，其阶段和独立确认仍会展示。用例输出使用有界、JSON 安全的报告，并明确标记非 JSON 内容或截断。成功还要求已挂载注册表、所选条目和活动 fiber 均指向精确输出 hash。没有阶段或中断的周期属于不确定结果，重试前必须检查。验收调用可能产生真实效果，激活并非隔离试运行。这是类型化 organ 生长，不是完整运行时编译器或自动发布提升。

Memory v2 保留原始 v1 文件，仅在显式变更时写入仅追加的伴随文件。不可变内容 ID、父级祖先链、限幅后的来源信任、修正和抑制后代的墓碑记录会保留来源信息，但不会把记忆当作权威。召回可以匹配前驱记录，但只披露其仍有效的最终修正。新近执行的有界 v4 会话扫描保留完整锚点；压缩、格式错误、缺失或超出预算的来源会返回 `UNDETERMINED`，而不是错误的 `EMPTY`。显式变更会在 VFS 写入之外另行等待本地 IndexedDB 确认，不声称已远程备份。本地前置条件和临时文件重命名后的回读不是跨标签页或分布式 CAS。

本地镜像投递在现有 IndexedDB 存储中使用不可变、带序号的批次，与本地变更原子提交。待处理路径和墓碑记录会阻止陈旧 hydration；递归删除会在重建当前子树前清除已存储的后代。单个发送方按最旧优先的顺序重试，只移除精确确认的批次。检查点文件进入同一个增量队列；不会上传陈旧的全 VFS 初始快照。本地 host 验证并串行处理批次和快照读取，保留私有、可恢复的待处理日志和重放回执，并保留源文件 mtime。这是本地有序投递，不是云备份或分布式冲突合并。旧的无序快照／增量写入会被拒绝，直到该客户端重载。`auma_snapshot(action:"sync")` 会等待发件箱处理完成，`body_map` 摘要会展示其状态。

更新后的写入方最多接纳 256 个待处理镜像批次，其完整序列化批次记录合计不超过 32 MiB，每批最多 50,000 个条目。这些固定的重复载荷安全上限不是浏览器配额估算，保留的旧客户端也不执行这些上限。接纳检查在同一事务内读取持久队列，并先于本地内容或序列元数据的变更；已有批次绝不丢弃或合并。队列已满时拒绝新保存，在打开的标签页中保留脏路径和新增 VFS 工作，并报告 `MIRROR_QUEUE_FULL`；应保持该标签页打开并保留其未保存工作。精确确认的投递会释放空间并安排重试保存。显式同步会先投递已有工作，再重试因容量受阻的保存；保存仍失败时绝不声称成功。单次变更过大会报告 `MIRROR_BATCH_TOO_LARGE`，投递已有批次不能使其满足上限。仅本地写入仍可接纳。`localSave` 将未保存路径数量、错误和容量拒绝与镜像投递状态分开报告；只有成功 flush 才清除保存错误。跨标签页的队列用量计数仅供参考；接纳会在其事务内重新测量。浏览器配额耗尽仍可能拒绝任何事务。

权威本地 HEAD 编辑会在激活前取得一个短暂的对等端写入方租约。host 在授予或续期租约、发布后代或修复 home 元数据副本之前验证所选 manifest。JSON 格式错误、JSON null 值、无效条目或摘要不匹配都会在这些写入发生前以 `SELECTED_HEAD_INVALID` 拒绝；它们绝不会被当作空创世状态的权威。精确匹配的租约释放仍然可用，以便调用方在检测到损坏后放弃并发协调。租约变更和 HTTP/WebSocket HEAD 发布共用同一个 host 队列；除父级／epoch CAS 外，所有者、到期时间和持久化的单调代际还会限制发布。运行时编辑会续期并释放自己的租约；有效授权即使由其所有者也不能替换，因此取得／释放结果不确定时，需要等待明确释放或到期。陈旧或竞争写入方会在激活前停止，被拒绝的候选仍会保留。后续编辑会采用变化后的 host 选择，同时保留本地 fork，并要求调用方针对新的 ballId 重试。租约是在现有会话能力下进行的并发协调，不是新凭据或强信任边界。它不提供云端协调，也不合并独立客户端的私有 VFS 数据。

运行时 `buildSha` 在构建时写入 worker；源码有变更时，明确附加 `-dirty` 后缀。`buildIdentity` 标识该源码修订、源码脏状态、构建时间、预构建运行时 worker 输入的 SHA256，以及已加载的内容寻址 worker 文件名。受支持的预览构建会在 Vite 写入标记前重新构建该运行时包。host 的可变仓库修订单独标为 `hostSourceSha`；推送 main 不能重新标记已运行的标签页。源码脏状态检查覆盖 packages、vendor 代码、Web 应用、构建脚本和根目录 package／lock 文件，不代表可复现的完整依赖闭包。没有构建标记的构建和 watch 构建报告 `UNVERIFIED`；watch 输出不复用干净的一次性构建标记。这是 bundle 身份标识，不是可复现构建或签名证明。

Seed organ 的 install／undo／retire 包装层会保留已选 HEAD 的变更确认。本地／host／回执持久化未确认时，返回 `ok:false` 和 `outcome:persistence-unconfirmed`，同时报告激活是否已经发生。Seed cycle 不会把该状态误认为 install 尚未执行，也不会在 undo 已激活后再执行第二次破坏性回退。Retire 现在会以可逆方式禁用所选条目，而不是先 undo 再删除恢复出的注册表条目。Install 和 undo 会把精确捕获的 HEAD 前置条件带入串行执行。

镜像协议元数据、日期范围、符号链接和有序父级／类型转换都会在写日志前预检。已确认的重放会跳过文件系统预检，且绝不会重新应用旧字节；真正中断的 I/O 仍会拒绝继续并等待恢复，不会被静默跳过。镜像 hydration 会先提交 IDB 导入，再修改 VFS。只有完成 hydration 并安装钩子后，持久化才会变为持久状态。

回执追加／检查点操作在模块热重载期间共用一个按 VFS 划分的队列，覆盖异步密钥／签名工作，不改变签名协议或创建身份。这不是跨标签页 CAS。写入方租约有不可续期的 60 秒操作期限；无限等待的激活不能永久续期 host 租约。所选 HEAD 先提交，其位于 home 中的可恢复元数据副本后提交；精确重放可以修复该副本。

镜像日志会持久化每个条目的进度游标，使恢复从未完成的后缀继续，而不是在稍后已被替换的祖先之下重放旧前缀。条目操作与游标更新之间发生崩溃时，只会重复该幂等基本操作。导入的文件／目录替换会原子清除陈旧的 IDB 后代，并保留子树重置元数据；仅本地保存的签名身份不会被祖先替换覆盖。文件 fsync 和 rename 不表示跨文件系统事务，也不保证断电持久性。

如果 host 丢失其所选 HEAD，而浏览器仍保留已有本地 HEAD，变更会在激活前以 `HEAD_AUTHORITY_MISSING` 停止，并保留该本地 fork。运行时不会静默把旧标签页选为恢复权威，也不会向空 host 发布无效后代。只有第一次空 genesis 的 Seed 启动可以自动初始化选择；恢复已有 fork 是显式恢复决策。

旧记忆迁移会把相同的必需内容 ID 归为一个确定性事实，保留全部原始键作为别名，并私下保留所有原始变体。修正或为该事实添加墓碑会影响每个别名；别名不是独立历史。修正会继续携带别名，查找／搜索仍会识别修正，原始迁移变体绝不会进入召回响应。其他位置仍严格验证重复 ID，不会编造时间戳／父级，原始 v1 文件保持不变。

变更错误会区分激活前已确认的拒绝（`not-applied`）与部分／不确定执行。租约／CAS／元数据拒绝不会声称已激活或回滚。持久化未确认但已知激活发生时，Seed cycle 仍运行验收用例，然后分别报告实际验收和持久性结果。插件执行仍在主运行时中；编译准备和回滚都不声称提供隔离沙箱。

快照恢复会在写入模块字节或改变 fiber 前，验证快照／内容 ID、原始 manifest ID 和每个提供的模块 hash。快照目标只允许内容 ID。无效恢复数据不能在恢复被拒绝前覆盖有效的不可变模块。

可选镜像 hydration 会在持久写入前验证并解码完整快照，拒绝非规范／重复路径、无效元数据和文件／后代冲突。经过筛选的导入还会在提交前检查保留的本地祖先和私有身份。导入事务内会重新检查完整持久读取集的标记；并发的仅本地保存、发件箱变更或另一次 hydration 会使可选导入被跳过，而不是覆盖更新的行。这不会合并独立标签页的 VFS 状态。

本地 host 提供 `/recovery/`，无需启动可替换 worker。该页面列出 hash 有效的保留候选并预览 organ 变更，然后通过现有串行化写入方租约／CAS 发布器，把较早的 organ／配置 manifest 选为新的前进 epoch。保留文件不是健康或此前已选的证明。恢复保留私有数据、回执、身份和写入方代际；它不恢复运行时 bundle、不撤销外部效果，也不自动恢复缺失的权威 HEAD。应新开 Auma 标签页验证实际激活；选择确认本身不是启动证据。

恢复页面会把未确认请求的精确目标／预期父级／epoch 保留在会话存储中，且只提供原始请求的重试。host 会在当前已选祖先链上识别其确定性结果；单独存在的保留候选文件不是应用回执。如果祖先链不可用或超出有界查找范围，恢复会拒绝，而不是为结果不确定的请求静默选择新父级。

IndexedDB 版本 2 会阻止旧的不检查修订的写入方，不删除已存储的行，也不替换身份。旧连接要么在版本变化时配合关闭，要么阻止升级；后一种情况下，新启动会停止、报告可操作错误并放弃该次升级，而不是强制关闭标签页。每次本地内容保存和镜像导入都会在各自事务中比较并推进一个持久修订；仅投递确认不会推进该修订。陈旧标签页保留尚未保存的 VFS 变更／脏路径，拒绝后续保存确认，并暴露冲突，直到重载或显式协调。该粗粒度的遇冲突即停止规则不合并并发记忆写入，也不静默丢弃竞争失败标签页的数据。

恢复不会向现有 worker 广播激活触发信号。新标签页启动所选 body，现有标签页则保留自己的 VFS，并在后续正常权威检查时协调。在存在显式迁移路径前，恢复会拒绝更改 memory 或 receipt organ 的活动代码／配置／禁用状态，以防止静默重新激活已知的旧记忆写入方。其他旧 organ 仍可能产生效果或存在不兼容，因此 hash 有效的保留 body 不保证其状态 schema 安全。

预览引导会在启动 worker 前只检查数据库元数据。除非元数据已经确认 v2 存储，否则都会先显示迁移提示并等待显式继续操作，包括新配置文件和检查不可用的情况。用户可以在任何 versionchange 关闭旧标签页的存储连接前，保留其中的待处理工作。提示不会声称易失工作已持久保存，Escape 会使提示继续显示，保持提示打开不会开始迁移。

本地 host 会在启动时，以及有序镜像替换或祖先删除前，为已定稿的 v1／v2 记忆文件保留私有、内容寻址的恢复副本。破坏性写入前，必须先保留并验证原有和传入的字节。新历史目录／文件仅所有者可访问；已有的不安全权限或符号链接会被拒绝；镜像变更前先完成独占发布及文件／目录 fsync。不支持目录同步、存储耗尽或历史损坏时，依赖写入会停止，不返回确认。基线捕获不会改写原文件。历史不参与 hydration、召回、Seed 导出或 Git，不会自动恢复或裁剪；受保护状态和 host 恢复页面只显示已验证的数量和字节数。这是对 host 启动／镜像写入的丢失控制，不提供跨配置文件冲突合并，不覆盖具有额外权限的 host 编辑，不是整机备份或多文件事务。保留版本会占用磁盘空间，需要在未来显式决定如何恢复。

本地 `x6_repo` 提交操作要求显式、有界的源码文件路径列表和非空消息。它拒绝私有镜像／生成路径、目录、符号链接、明显的凭据材料和任何预先存在的暂存内容。桥接请求串行执行，只暂存具名的字面路径，且只提交这些路径；失败时绝不重置或恢复无关工作，错误会报告尝试过的暂存操作，供调用方检查。仅对该提交命令禁用格式化钩子，防止其改写用户文件。该保护会限制路径，但不能为相同具名文件提供相对于其他高权限进程编辑的不可变字节快照隔离；调用方需要运行检查并审查精确结果。这是更安全的便捷提交功能，不是对另行具有额外权限的 host exec 桥接的沙箱，也不是完整的秘密检测器。发布前，调用方仍须审查精确 diff。

本地 host 会在提供构建前，保留具名不可变预览资源的已验证副本。在更新的 Vite 构建移除其 dist 文件后，缺失的旧 JS／CSS／字体／图片资源、固定的 Scion Wasm 和按内容命名的懒加载归档仍可逐字节提供。SHA256 对象和精确的路径／摘要索引位于被忽略的本地缓存存储中；文件名冲突、对象损坏、符号链接或配置的缓存预算耗尽时会报告失败，不会替换字节。独立于 worker 的恢复页面显示保留状态。受保护的 `/_host/runtime-assets` GET 报告状态，POST 捕获当前 dist，若另一进程持有捕获锁则最多等待 30 秒（若记录的持有者已不存在则立即拒绝，且从不删除该锁），随后以 `ASSET_CACHE_CAPTURE_LOCKED` 拒绝并给出持有者 pid；`X6_ASSET_CACHE_MAX_BYTES` 默认 256 MiB，不自动裁剪。捕获失败时保留此前对象，当前 dist 仍可使用。全局不可变路径回退不包括 HTML、可变 VFS 镜像、源码映射和私有镜像文件；下述完整运行时闭包会单独保留具名的公共部署文件。这是打开标签页的资源连续性支持，不是完整发布闭包、健康证明、自动 worker 替换或 last_good 运行时选择。

受支持的预览构建在独占本地构建锁下串行执行其生产步骤。它会在 Vite 清空 dist 前捕获此前已封存的资源，只有编译器、Vite 和 VFS 打包全部成功后才发布有界的路径／SHA256／大小清单，并捕获该完整清单。捕获会在发布索引前重新检查封存记录和源字节。已经验证的旧构建可以使用 `node server/build-preview.mjs --seal-existing` 显式封存；这只记录字节清单，不表示健康或权威。失败／取消的构建绝不封存不完整输出。捕获使用独立、独占且不可抢占的锁，并重新加载共享索引，因此另一个 host 不能基于陈旧的内存视图覆盖映射。陈旧锁和中断生产步骤的结果需要操作人员检查，不会自动接管；子进程是否完成不确定时，取消会保留构建锁。历史对象缺失／损坏时，保留状态会持续降级，直到修复；状态会把物理对象字节计入预算，包括未索引文件和中断的临时文件。没有 host 时会报告不保证保留；运行中的 host 保留失败时，会在旧输出被替换前阻止受支持的重新构建。不遵守该构建协议的其他高权限写入方不在保证范围内。

预览构建锁存在时，host 只从缓存提供已保留的具名资源；新的 HTML／镜像启动会以 HTTP 503 等待，不会混用不完整构建输出。恢复和受保护 API 仍可使用，不会强制重载任何打开的标签页。陈旧构建锁会持续阻止启动，直到检查其中断的生产步骤。缺失资源路径绝不会回退到 SPA HTML。静态读取会持有并验证文件描述符，避免在 dist 替换期间留下未处理的流打开竞态。

如果某个生产步骤在清空 dist 后、封存前失败，切勿封存该不完整输出。先检查失败的生产步骤和保留缓存的健康状态，再使用 `node server/build-preview.mjs --rebuild-unsealed`，仅将未封存的构建输出替换为新的完整构建。该显式恢复命令会拒绝已有封存记录，并保持此前缓存对象不变；它不会证明这些对象健康。中断的构建会保留锁，因此手动清除陈旧锁前应先确认生产进程已终止。普通重新构建仍会拒绝继续，不会静默把不完整输出当作有效前驱。

读取当前 dist 前后都会检查持久构建代际标记。代际变化、活动写入方、失败构建或中断生产步骤都会暂停新启动，而不是返回跨构建转换读取的字节。已保留的具名资源仍可使用。这不是所有标签页的原子更新，也不声称另行具有额外权限的写入方无法绕过受支持协议。

新完成的构建还会封存独立的静态运行时闭包，其中包含原始 HTML、VFS 镜像、具名资源、懒加载归档、fixture、图标和 PWA manifest，但不包括诊断用源码映射和私有镜像状态。闭包文件共享已验证的本地对象池，但可变文件名绝不会进入全局不可变路径索引。只有每个提供的文件都与完整构建封存记录一致后，才会发布内容寻址的发布 manifest。旧的仅资源清单绝不会事后获得存储兼容性声明。

受保护的 host 运行时 API 会列出这些闭包，显式的 `/?runtime_candidate=<releaseId>` 可以在不更改全局运行时选择的情况下启动其中一个。host 只改写保留 HTML 的资源属性和 PWA 路径；原始字节仍被固定，响应／源摘要分别记录。引导镜像在其所属发布模块旁解析，使懒加载归档和 Scion 保持相对于该发布的位置。发布路由在可变 dist 构建检查前处理，绝不回退到当前文件。候选启动是真实运行：它使用现有存储、当前 organ HEAD 和 broker，可能产生效果，不是隔离试运行。这些由生产方声明的 protocol-2 闭包只是候选，不是已经观察到健康的发布或 last_good。私有状态回滚仍不可用。前进运行时选择是独立、显式的操作。

运行时提供不依赖可变资源路径索引：即使该索引无法加载，完整的闭包 manifest 和对象仍可使用。发布前会检查公开文件路径的 URL 安全性、受支持 HTML／PWA 引用的完整性，以及发布 manifest 的大小／数量上限。配置的载荷预算包含对象和发布描述符的字节，包括中断的临时文件；有界的可变索引和锁元数据是额外开销。候选页面显示实时访问提示条，在同页历史导航时保留其发布查询参数。返回 main 需要显式导航，并提示待处理工作；不会创建全局或持久的候选偏好。

候选查询参数也会绑定普通 HTML 深链接入口；直接访问保留的入口 HTML 会重定向到该显式候选 URL，防止绕过实时访问警告而静默启动。不支持的发布路径、方法和引用会被拒绝。SPA 历史变化期间保留查询参数，而有意完整导航回 main 入口则离开候选。

受支持的预览生产步骤会在打包 JavaScript 前刷新运行时声明，使 Web 引导按同一份导出的客户端 API 检查，而不是使用陈旧的生成类型。

host 可以通过独立的前进日志，显式选择一个保留运行时用于后续 main 入口。捕获绝不会晋升发布。选择会比较精确的当前记录 hash 和 epoch，将一个操作 UUID 绑定到完整请求，验证每个目标闭包对象，并按意图 → 不可变转换 → 唯一已选指针 → 回执的顺序持久化，确认前完成目录同步。结果未知时会保留原始请求；精确重放不会增加 epoch。已有历史后权威缺失时会拒绝继续；只有精确的待处理首次操作且不存在 HEAD 之后的回执时，才能协调中断的 genesis。绝不会抢占陈旧写入方锁。

所选 main HTML 及其带发布前缀的文件会在可变 dist 构建检查前提供；活动 worker、organ HEAD、记忆、身份和回执不会倒退或自动重载。PWA 的 main 启动保持使用所选 main 入口。选择确认不能证明启动、健康或独立见证的 last_good。候选启动仍然是显式、真实的运行。即使选择元数据不可用，恢复也保留对完整候选的访问，不会静默重置 main 权威。

`buildIdentity.runtimeReleaseId` 来自正在执行的 worker 的发布 URL，而不是 host 的当前选择。可变 dist 启动报告 null；保留候选或所选运行时会报告其实际固定的闭包，即使此后 main 发生变化也不例外。

普通的运行时选择读取不会创建锁，也不会执行恢复写入。主入口要求所选记录、匹配的不可变历史，以及在 HEAD 持久化之后写入的持久回执；发布未完成时会报告不确定状态，而不是悄悄选择可变 dist。即使写锁或待处理意图阻止新选择，只要所选记录有有效回执支持，它仍可读取。只有显式选择或重试才进入写入协调，并协调先前的持久意图。

本地 host 在 JSON 端点和模型／fetch 代理中，每个 HTTP 请求体最多缓冲 64 MiB。声明长度或分块实际长度超限的请求会在路由变更或上游发送前收到 `413 REQUEST_BODY_TOO_LARGE`，并关闭连接。这是单个请求的载荷上限，不是总堆内存或并发数量上限；上游响应流仍按流传送。

非回环来源必须先取得经过身份验证的 `x61-cloud-mirror/v1` 快照，才能创建可远程投递的批次。新存储会将其谱系／修订与导入内容一并提交。云端基准缺失、变化或不明确时，只影响镜像状态：本地 IndexedDB 保存仍可用，但仍受本地内容修订 CAS 和浏览器存储故障约束。不可变批次包含推导出的云端基准和精确的序列链；匹配的回执会在精确移除发件箱条目的同一原子操作中，推进已确认的基准和序列。投递绝不会改写陈旧的隔离标记。

云端准入上限为每个编码请求 16 MiB、10,000 个条目，以及每个文件 8 MiB。隔离标记不安全、云端容量拒绝或云端队列已满时，本地内容会与一个固定大小的协调标记一起保存；该标记记录所有持久镜像内容首次及最近受影响的内容修订，包括删除标记和子树重置。已有队列中的信封保持不变。在显式协调前，后续编辑仅保留在本地；排空较早的信封绝不会清除此标记，也不会报告完全同步。该标记保留最新的持久内容，不保留每次中间编辑，也不是独立备份。不提供自动协调。回环地址（`localhost`、`127.0.0.1`、`[::1]`）保留本地 v2 传输行为。云端冲突保留有明确上限，不会逐出较早的冲突；远程保留失败绝不能代替本地保存确认。

云端路径准入会在创建信封前，以及传输保留的信封前，再次检查规范路径、根目录和保留的含秘密名称。新近被拒绝的变更会与协调标记一起保存在本地；较早的禁用信封保持不变，且不会被传输。这些检查不改变本地 v2 行为。

即使传输过滤后没有产生协议条目，清空云端镜像根目录或祖先目录仍需协调。其本地内容修订与协调标记一并提交，因此空发件箱不能将这些删除错误地报告为已同步。普通的仅私有内容写入仍不受此要求约束。

T2 `promote_staged` 会将本地保留的晋升信封上传到 `/_head/stage`；试运行不会上传。只有得到确认的 `awaiting_owner` 响应才会报告 `stagedForOwner`，失败时会暴露 `stageError`，不会声称已晋升或已获所有者批准。`promotion_status` 区分成功的 T1 所有者会话（`t1-session`）和已消费的批准 token。新晋升回执要求完整的 64 位十六进制 ball 及父级标识符，以及 T1/T2 层级；匹配历史 epoch 时保持原有记录不可变，并抑制重复恢复。仓库 write/edit/commit 操作中，位于 `docs/**/*.md` 下或匹配根目录 `NORTH-STAR*.md` 的路径只绕过历史文件名启发式检查，仍保留其他所有授权和秘密检查。

保留测试的准入判定只使用经过验证且完整匹配构建基准的用例行来计算覆盖和改进；目标必须与候选器官相同，夹具必须属于基准，规范化后的作者必须精确匹配构建内的 `dot` 允许名单。作者规范化使用 NFKC 并移除默认可忽略码点；大小写及首尾空白仍有意义。构建器要求目标器官标识符有效（不要求属于套件的器官列表），且作者字段如存在必须为字面值 `dot`。每个符合条件的用例在两个试验分支中分别使用全新 worker、基准夹具和时钟单独运行；候选器官必须通过所有这些用例，并至少改进一个。候选与现任器官分别独立运行，按固定顺序比较全部固定用例，不论作者；只有在线候选运行通过而固定用例运行失败时，才报告 `PEARL_SUITE_PINNED_ONLY_FAILED`；固定用例证据不完整时报告 `PEARL_SUITE_PINNED_ONLY_INCOMPLETE`。完整在线比较与仅固定用例比较都要求目标器官的每行通过，并禁止现任器官通过的任何行在候选运行中失败。非目标行在两个分支均失败且有界 `{phase, code, subject}` 记录多重集合完全相同时，视为未变化且不参与判定；归属目标的 `PEARL_ORGAN_NOT_MOUNTED` 记录不能使用此例外；通过总数不能决定胜者。`ok` 表示在线比较义务是否满足，`trialOk` 保留全部行通过的原始结果。候选在线运行的基础设施或行为失败报告 `PEARL_SUITE_LIVE_FAILED`；结果格式缺失报告 `PEARL_SUITE_LIVE_INCOMPLETE`。完整的隔离失败和平局分别报告 `PEARL_SUITE_ISOLATED_FAILED` 与 `PEARL_SUITE_NOT_IMPROVED`。目标候选基础设施失败拒绝准入。现任器官的导出、工厂或 setup 挂载失败仅在每条记录均指向目标且回答精确为 `{ok:false,error:'PEARL_ORGAN_NOT_MOUNTED'}` 时视为完整失败，其他器官调用目标时也适用。拒绝用例行自身的守卫失败仅在回答尚未匹配预期拒绝时计入。此守卫例外是试验准入策略，不证明在不受限制的生产环境中失败。其他目标基础设施失败、结果格式缺失和记录饱和仍视为不完整。被拒绝的比较不报告胜者。结果报告 `pinnedTargetedCases`、`pinnedOnlyPassed` 和独立保存、已验证的 `baselineDigest`。构建固定信息缺失、无效或仅包含旧版摘要时报告 `PEARL_SUITE_PIN_UNAVAILABLE`；在线套件缺失或改动已固定行时报告 `PEARL_SUITE_PIN_MISMATCH`。没有符合条件的独立目标行时报告 `PEARL_SUITE_NO_APPROVED_TARGET_CASE`。两种固定信息错误都拒绝准入，且不报告胜者或已完成的比较。

保留测试运行器将器官工厂与私有测试框架分别编译，不强制器官源码进入严格模式。仅运行名称精确匹配的可调用 Seed 导出，同伴调用也遵循此规则；仅插件导出不算可调用器官。框架拥有的逐用例基础设施记录保留导入、守卫、依赖、工厂、导出、setup 和超时失败，即使候选代码捕获或重写错误也不会清除记录。记录包含负责的器官；归属不明和饱和仍视为不完整。候选返回的记录不能替代它们。缺失的上下文服务、嵌套 tools/organs/snapshots/文件系统成员和 process 能力记录依赖失败；未提供的 `organs.list` 在调用时也记录，而 `process.getBuiltinModule` 使用受守卫保护的导入。用例声明的拒绝仅在基础设施记录为空时匹配目标 run 的错误，且错误必须等于预期代码或以该代码加 `:` 开头。工厂与 setup 在相同守卫下执行；无效导出与初始化失败使用固定的基础设施代码。每行使用全新的无网络、无 origin 文件系统夹具和固定时钟，而非生产服务。夹具代理隐藏直接的 `location` 与 `globalThis.location`，其余全局读写正常转发，并保留原生 crypto 接收者。原生全局身份与别名仍然可用：这是 origin 夹具，不是隔离边界。这些检查不证明完整的 Cordis 激活或待处理依赖已就绪。`tree_patch` 挂载已准入候选后，挂载 SHA 必须与准入 SHA 相同才会推进 HEAD，否则抛出 `PEARL_ADMITTED_MOUNT_SHA_MISMATCH`。挂载副作用可能已经发生；此失败不会自动回滚。

只有当前已挂载、处于 ACTIVE 状态且与 HEAD 精确匹配的 `seed-pearl` 私有上下文才能记录准入资格。全局调用和其他器官的比较仍仅用于诊断。签发前会在全部试验完成后重新检查唯一挂载记录和 fiber，因此销毁、卸载中以及相同字节的重启都会撤销旧上下文。Seed 包装器捕获 run/setup 回调，并以冻结的浅层导出快照作为接收者；回调不能依赖修改 `this`。冻结内建函数在加载器官前捕获。此边界假设宿主内建函数与经过验证的 Pearl 实现可信，不隔离同一 JavaScript 执行域中的任意代码，也不声称能认证调用栈。
