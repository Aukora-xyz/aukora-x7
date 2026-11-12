# Cloudflare 边缘端

[English](README.md) | 中文

这是本仓库浏览器运行时的边缘适配器。它不会连接本地宿主机器、隐式导入本地镜像，也不会更改现有服务；它使用自己的 Durable Object 命名空间和存储桶。

## 当前状态

已部署的 Worker 必须完成所有者身份验证、提供方密钥配置、自定义域名配置及经过身份验证的引导初始化，才能提供浏览器应用。所有者身份验证接受已配置的 Cloudflare Access，或绑定到所配置公钥、主机和电子邮件地址的 Ed25519 所有者断言。身份验证配置缺失或无效时，系统拒绝访问。已提交的配置仅面向 node.example.invalid；源代码配置不能证明已经部署。这些文件不会创建任何凭据。

浏览器仍然运行 Cordis agent（智能体）。Worker 提供经过身份验证的静态资源、提供方入口、选定 head 的比较并交换、organ 发布写入租约、在线状态，以及专用 Durable Objects 中有序的私有虚拟文件系统（VFS）持久化。所有标签页关闭后，它不会运行 agent。Durable Object 存储是远程持久化，不是独立的 R2 备份。

原生 shell 和本地仓库访问、截图、Cloudflare 部署及运行时发布恢复仍不可用。公共 HTTPS 读取要求下文所述的运行时网络保护。有界云端代理绝不会回退到本地机器。提供方轮次 ID 在分派后持久化为只能使用一次；自动重试和边缘恢复尚未实现。源代码中的能力不会创建生产环境凭据、配置绑定，也不能证明已有线上部署。

## 配置与验证

1. 批准 node.example.invalid 的生产环境身份验证方式。Cloudflare Access 需要实际的团队、受众和所有者电子邮件地址。Ed25519 所有者身份验证需要已验证的公钥、精确主机和所有者电子邮件地址，以及供所有者获取短期签名断言的独立可信途径。不得未经验证便复制受众，也不得将公钥的存在视为激活另一访问路径的批准。
2. 在为此新 Worker 配置现有提供方凭据以供持续使用之前，取得所需批准。在对应密钥绑定存在之前，提供方入口始终返回 503。绝不得将密钥值放入本仓库、浏览器镜像或命令记录。
3. 使用仓库支持的构建流程构建实际浏览器预览。上传前检查其 VFS 镜像和打包的构建身份。不得用未提交的本地宿主或仅含静态内容的演示替代。
4. 将 SOURCE_REVISION 设置为已验证的已部署浏览器源代码修订版本。保护措施就绪后，仅添加新的 node.example.invalid 自定义域名路由。从此配置部署。
5. 检查未认证请求被拒绝、所有者登录、首次启动、真实模型回复、重新加载后的持久化、双标签页隔离、organ 编译／应用／撤销及实际远程确认。检查你运行的其他节点保持不变。

聚焦的引导初始化测试套件使用内存中的 Durable Objects 和合成镜像内容；它不能证明已部署浏览器的使用流程或 Cloudflare 资源行为。线上验收需要在部署安全配置和记忆传输获准后，使用真实主应用进行。

## 引导初始化驱动程序

`node server/cloudflare-bootstrap-cli.mjs --dry-run` 捕获并验证当前检出仓库的镜像，不执行写入或网络请求。`--mirror <directory>` 选择另一来源；`--package <saved-directory>` 则检查现有包。输出仅包含 seed ID、ball ID、epoch、批次数和序列化字节数。变化中的来源、不一致的 head 副本、格式错误的模块或被排除的私有路径，均不能被静默纳入成功的 seed。

`node server/cloudflare-bootstrap-cli.mjs --prepare --out <new-private-directory>` 离线保存已验证的包。输出目录必须不存在，且必须位于源镜像之外。请保持此目录不变：其中包含获准的记忆字节和上传中断后所需的精确批次摘要。它属于私有数据，不是仓库产物。准备模式与 dry-run 读取同一镜像；两种模式均不读取凭据。

所有者批准将该确切的包传输到 Cloudflare 后，使用 `node server/cloudflare-bootstrap-cli.mjs --url https://node.example.invalid --package <saved-directory> --confirm-seed-id <seed-id> --access-token-stdin`。通过非交互式标准输入提供已获授权且未过期的 RS256 Cloudflare Access JWT 或 EdDSA 所有者 JWT，绝不得将其作为命令参数、仓库文件或日志值。CLI（命令行界面）仅以 `CF_Authorization` cookie 将 token 发送到固定的 HTTPS 引导初始化端点。它不会创建、刷新或保存凭据；服务器会验证 token 的签发者、受众、签名和所有者。身份验证激活、断言签发及提供方密钥配置仍是独立操作。CLI 仅检查 token 的结构和有效期；它不能确认签名者或所有者身份。

上传使用已保存的包，不重新扫描。传输前会验证完整的包，然后依次执行准备、有序批次和提交，并检查 HEAD 与 MIRROR 确认是否匹配。已有的不相关状态会导致拒绝。未完成的运行仅能使用同一 seed，并从已确认的批次位置恢复。超时、格式错误的确认或响应丢失会导致停止，不会自动重试；请保留已保存的包，并在明确恢复前检查结果。不存在覆盖、重置或回滚选项。

`node --test server/cloudflare-bootstrap.test.mjs` 使用隔离存储和合成 home 内容测试驱动程序及真实 Worker／DO 处理程序。fixture（测试前置数据）读取当前检出仓库的 head 和不可变模块源代码，但不执行这些模块。它绝不会向线上命名空间写入 seed、调用提供方或更改真实镜像。此套件不验证 Cloudflare 内存限制、已部署资源或所有标签页关闭后的 agent loop。

## 存储限制

引导初始化和镜像上传每个请求上限为 34 MiB，seed 批次的序列化条目上限为 32 MiB。普通 Worker 请求仍以 16 MiB 为上限。镜像文件上限为 24 MiB（base64 编码后为 32 MiB，因此一个此大小的文件及其批次封装可放入单个请求），保留的 VFS 条目上限为 20,000 个，解码后的文件状态上限为 128 MiB，路径元数据上限为 8 MiB。每个存储值上限为 120 KiB，文件／冲突载荷拆分为 96 KiB 分片。完整序列化快照上限为 96 MiB；会超出该导出预算的批次在修改状态前失败。快照读取会验证元数据、分片长度和 base64 填充，并在流式传输时强制校验精确的传输字节数。协议回放确认为每个客户端最多保留最新的 64 条，全局最多保留 4,096 条，客户端最多为 256 个。全局容量压力可能使某个客户端保留不足 64 条；每个客户端最新的确认始终受到保护。`/dsh/home/auma/snapshots/` 下的快照转储（除 `LATEST.json` 外）被排除在云端镜像之外，浏览器的云端发件箱会在发送前丢弃它们。浏览器的云端发件箱使用相同的请求、文件和快照限制（`idb-persist.ts` 中的 `CLOUD_MIRROR_LIMITS`，由一致性测试固定），其本地队列接纳一个 40 MiB 批次。历史记忆版本尚未实现。具名运行时回滚快照也不会远程保留：运行时列出具名文件，而每次启动都会替换 LATEST.json。不得将此镜像视为新浏览器上的历史快照恢复机制。当前镜像源代码采用分片内容和流式快照，但尚未在实际 Cloudflare 运行时上运行。

MirrorDO 将 `mirror-replay.mjs` 的裁剪与成功发布一并原子执行。客户端序列号／摘要隔离记录及全局 lineage／修订版本仍然永久保留；内容、删除标记、引导初始化状态及用户记忆回执日志不会被压缩。已裁剪确认的重试返回 HTTP 409 `MIRROR_REPLAY_EXPIRED` 并尝试保留冲突；冲突存储已满时，改为返回 HTTP 507 `MIRROR_CONFLICT_CAPACITY_EXCEEDED`，并附带 `conflictCode: MIRROR_REPLAY_EXPIRED`。两种结果均不会重新应用批次或确认交付。现有完整且具有有效隔离记录的库存会在下一次成功发布时减少确认数量；格式错误、不完整或缺少隔离记录的库存会导致拒绝操作。这不意味着存在独立迁移或已在生产环境激活。

## 删除连续性

快照公开 `snapshotFormat: "x61-mirror-snapshot/v2"`、`resetPaths` 和仍然存在的 `entries`。删除和文件／目录替换会将子树重置与条目修改、全局修订版本和回放回执一并原子保留。后续重新创建不会清除重置；祖先重置涵盖子级重置。重置和条目均计入存储限制。

读取方请求 `/api/snapshot?snapshotFormat=x61-mirror-snapshot/v2`，验证所有路径，然后先持久化清除允许重置的子树，再覆盖仍然存在的条目。如果重置会擦除本地私有身份、受保护的不可变模块或尚未完成的本地工作，读取方必须拒绝。一旦存在重置，旧读取方会收到 `MIRROR_SNAPSHOT_UPGRADE_REQUIRED`，而不是会让打包文件重新出现的快照。浏览器 hydration 读取方请求 v2，并在仍然存在的条目之前持久化应用允许的子树重置。重置可防止将来文件重新出现，但不能重建旧部署已经丢弃的删除记录。

云端和本地宿主镜像的接纳检查拒绝秘密路径段及其后代，包括 `.ssh`、`.aws`、`.transport`、凭据文件、`.env*` 和 `.aukora-*`。本地快照遍历在进入私有目录前应用同样的排除规则。这是纵深防御；浏览器也必须在传输前排除这些路径。

云端镜像还排除每个精确等于 `.conflict-backup` 的路径段及其后代。引导初始化扫描使用同一云端策略，不打开被排除的目录。本地恢复备份和本地宿主传输保持不变。现有云端条目或重置记录若位于被排除的路径，验证会失败；它们不会被静默过滤或删除。应保留不可变的排队批次和已保存的 seed 包，不得改写其摘要。在现有状态上部署之前，请遵循[云端备份排除升级指南](../../docs/upgrade-guide/v0.2.2-alpha.2/cloud-conflict-backup-exclusion/guide.zh.md)，并为任何必要的状态协调另行取得授权。

## 所有者 token 浏览器登录

所有者断言是紧凑的 EdDSA JWT，由所配置 Ed25519 私钥的持有者在 Worker 外部签名。其标头仅包含 `alg: "EdDSA"` 和 `typ: "JWT"`；其声明仅包含 `iss: "aukora.x61.owner"`、等于 `PUBLIC_HOST` 的 `aud`、与 `OWNER_EMAIL` 匹配的 `email`，以及有限数值的 `nbf` 和 `exp` 秒数。两个 JSON 对象均采用紧凑的 `JSON.stringify` 编码和规范的无填充 base64url。当前时间必须满足 `nbf <= now < exp`；`exp - nbf` 不得超过 24 小时，超过此上限的 token 会被拒绝。较短有效期的有效 token 仍被接受，不添加 `sub`、`iat` 或任何新权限。持有此 bearer token 即可在过期前访问应用；这不代表获准签署所有者授权。

[签发工具](../../server/mint-owner-jwt.mjs)接受 1–24 小时的整数有效期，默认值为 24 小时。上限和默认值为 24 小时（由 12 小时调高），这是有意的调整，其代价是被盗的 bearer token 可被使用更长时间。此调整不会续期或延长现有 token。[共享验证器](src/access.mjs)也对[显式配置的本地登记](../../server/local-enrollment.mjs)应用此上限，不改变本地受众绑定或登记授权规则。

`POST /_auth/owner` 接受原始 JWT，要求 `Content-Type: application/jwt`、精确同源的 `Origin` 和 `Sec-Fetch-Site: same-origin`。它先验证 token，然后签发 HttpOnly、Secure、SameSite=Strict 且仅限当前主机的 `CF_Authorization` cookie。其有效期不超过 token 的剩余有效期，交换过程绝不会延长有效期。提交的 JWT 是唯一登录凭据；现有 cookie 或标头不能代替它，因此可交换另行签名的替代 token，而不会延长其过期时间。请求体上限为 16 KiB，读取期限为十秒。此端点可在引导初始化前运行，但不会提供应用，也不会绕过引导初始化。token 绝不会通过 JSON 返回或被写入日志。

对 `/`、`/index.html` 或 `/preview.html` 的未认证 HTML 文档请求会收到独立的登录页面，HTTP 状态为 401。请求必须是精确的 `GET`，不含查询参数或片段，并明确以正质量值接受 `text/html`；若提供了 fetch 元数据，则必须表明这是文档导航。此页面不加载应用资源，并使用 `Cache-Control: no-store`、`nosniff` 及严格的内容安全策略。其他所有未认证路由仍返回 JSON 拒绝响应；主机、身份验证配置和来源检查仍在失败时拒绝访问。

此页面仅向 `POST /_auth/owner` 提交现有所有者 JWT，在发送前及 `pagehide`/`pageshow` 时清空输入，并且只允许一个进行中的尝试，期限为十秒。交换成功后，页面被 `/` 替换；已中断或陈旧的尝试不能触发导航。这是登录界面和 cookie 交换机制，不是 token 签发器、密钥配置服务或续期服务。新电脑仍需通过可信途径获取已授权的断言。不得将所有者的私有签名密钥加载到浏览器应用、其 VFS、模型提示词或本仓库中。激活此访问方式属于独立的生产环境安全变更；源代码及隔离测试不能验证部署或线上所有者登录。

## 边缘 Aura 证据

Head Durable Object 通过其绑定的 Mirror Durable Object 读取当前 Aura 输入。内部 `/_mirror/aura-inputs` 路由要求内部授权以及匹配的已完成引导初始化身份；公共 Worker 不会转发此路由。读取方检查有界的回执、DAG、交接、发现和分配证据，并返回汇总指标，而非原始私有文件。Head 身份和镜像修订版本检查会拒绝跨异步读取期间发生的变化。缺失、损坏、过大、超时或不一致的输入保持不完整状态，向量为 null。

唤醒 alarm 可以在没有本地机器或浏览器标签页的情况下计算并保留这些外围注意力提示。调用模型的唤醒执行要求精确设置 `WAKE_EXECUTOR_ENABLED=1`、已配置的提供商及其现有预算；仅有凭据不会启用执行。设置为 `0`、缺失或任何其他值时，定时／手动探测及直接 `wish_step` 调用均不会执行云端步骤、预留预算或写入执行状态。唤醒调度、回执和外围提示仍然可用。已启用的 manifest（元数据清单）条目描述的是选择，而非观测到的 organ 健康状态；唤醒执行不会授予审批权限。

## 确定性事实

源代码将经过身份验证且不含请求体的 `GET /__x6/facts` 和 `GET /api/x61/facts` 请求，通过已完成的引导初始化路由到 Head 及其绑定的 Mirror。查询参数和片段被拒绝。响应投影一个新鲜且一致的快照：选定 head 的身份、已声明／启用的 organ 数量、已验证回执总数和按种类统计的数量、检查点覆盖范围、DAG 数量及 Aura 注意力指标。它不会调用模型、公开原始记忆或凭据，也不会修改状态。

只有在验证回执哈希及链、检查点签名和所覆盖的回执前缀后，才会返回完整数量。检查点签名者的信任明确标为未固定：有效签名既不代表所有者批准，也不代表独立审计。organ 选择不代表运行时健康。证据缺失、损坏、不一致或不可用时，返回 HTTP 503、不完整状态及 null 数量，而不是伪造表示健康的零值。响应使用 `Cache-Control: no-store`。源代码处理程序和隔离测试不能证明任一端点已部署或已上线。

AUMLOK 事实接受旧版邀请计数和有界的 `lifetimeIssuedCount` 字段，不公开额外身份数据。累计数量不得小于当月签发数或撤销数，不得超过 128，未绑定时必须为零。邀请列表和兑换仅在边缘端可用：本地主机在处理通行密钥之前返回 `501 AUMLOK_EDGE_ONLY_ROUTE`。两个状态别名（`/__x6/status` 和 `/api/x61/status`）均将运行时标为 `cloudflare` 或 `local`；此字段不能证明健康状态。

## 可选边缘探测辅助模块

`edge-turn-probe.mjs` 定义了默认禁用的只读分类辅助模块。它需要所有者配置的模型服务绑定和可信的新鲜上下文读取方，两者均未接入生产环境 Head 构造函数。经明确且可信的启用后，它仅发送关注点和紧急程度、接受有界分类，不提供工具、授权指令、记忆内容或任务执行。现有唤醒运行器必须负责期限、中止及持久化单任务占用记录。它没有公共网络回退、凭据配置或自动重试。此辅助模块不能证明已实现关闭所有标签页后的 agent loop，也不能证明模型探测已上线。

## 身份验证与有界读取

公共应用路由，包括镜像修改、快照读取和静态资源，均要求有效的所有者断言。Cloudflare Access 断言采用 RS256 及所配置的签发者和受众。Ed25519 所有者断言采用 EdDSA 及所配置的公钥、精确公共主机和所有者电子邮件地址。配置缺失时拒绝访问。在普通应用路由上，多个断言标头及授权 cookie 必须一致；不同的 Cloudflare Access 和所有者 token 会被拒绝，而不是按优先级选择。应始终使用同一条已配置的登录路径。Worker 在向其 Durable Objects 转发已认证请求之前，会移除调用方提供的内部授权标记。本地宿主能力 cookie 和镜像 bearer token 均不能绕过身份验证。有序写入使用 `/_mirror/delta`；不支持旧版 `/_mirror/push`。状态路由为 `/api/health`、`/_mirror/status` 和 `/_head/ball`。

浏览器从读取标头到读取完整响应体始终使用同一期限：hydration 为 8 秒，交付为 15 秒。成功快照上限为 96 MiB；确认和错误响应上限为 64 KiB。字节限制应用于流式解码后的字节，格式错误的 UTF-8 会被拒绝，采用 identity 编码时 Content-Length 必须匹配。失败或截断的响应不能确认或移除其排队批次。快照重置不能选择受保护的根目录或不可变 ball 存储。

## 云端能力检查

经过所有者身份验证的 `GET /_host/selftest`，以及携带 `action: selftest` 的 `POST /_host/repo`，均要求 HEAD/MIRROR 已完成且相互匹配的引导初始化，以及 `Sec-Fetch-Site: same-origin`。仅 selftest GET 可省略 `Origin`；若提供 `Origin`，则必须匹配；若提供 `Referer`，则必须同源且不含 URL 凭据。POST 保留精确同源要求。

有界只读报告观测 HEAD、MIRROR、AUMLOK 单凭据绑定状态及构建元数据。提供方配置是否存在记录在 `providerDoors` 下；代理标志位于 `brokers.githubConfigured`、`brokers.cloudflareConfigured`、`brokers.webEyesConfigured` 和 `brokers.trustedDocsConfigured`。它不会发送提供方请求或执行发布。缺失或无效的观测仍标记为不可用或无效；即使 `ok: true` 也不能证明凭据有效、模型可用、运行时健康或部署成功。

引导初始化的 HEAD/MIRROR 读取各自具有 60 秒期限。后续代理请求体读取及每项 selftest 投影分别具有十秒期限。这些分阶段限制并非十秒的端到端期限。

## 有界边缘诊断

经过所有者身份验证且无请求体的 `GET /_host/diagnostics`，以及内容严格为 `{"action":"diagnostics"}` 的 `POST /_host/repo`，要求已完成成对引导初始化，并带有 `Sec-Fetch-Site: same-origin`。POST 要求精确匹配的 `Origin`。GET 可以省略 `Origin`；若提供则必须匹配，且任何 `Referer` 都必须同源并且不含 URL 凭据。查询参数和片段均被拒绝。

响应分别提供 `worker`、`head` 和 `mirror`。每个可用范围按响应就绪顺序保留最多 100 个已处理请求，大小不超过 32 KiB。事件包含以 Unix 纪元毫秒表示的开始时间 `at`、取值受限的 `method`、规范化的 `pathname`、HTTP `status`、固定的 `HTTP_<status>` `code`，以及上限为 24 小时的 `durationMs`。状态和时长的观测截至处理程序返回 Response 或抛出异常时；处理程序抛出异常时记录合成 HTTP 500。后续 SSE（Server-Sent Events）或快照流错误、传输失败及 WebSocket 流量均不可见。Mirror 时长包含队列等待时间。提供方路径转换为 `/door/:provider`；未知路径转换为 `/:other`。记录器不存储请求体或响应体、查询参数、标头、凭据或原始错误文本。代码表示 HTTP 状态，而非应用错误详情。

历史记录属于单个 Worker isolate 或 Durable Object 实例，重启后消失，且不包含仍在执行中的本次读取。它们不是全局持久审计、浏览器网络捕获或部署证据。不可用或无效的组件返回 `state: unavailable` 和 `DIAGNOSTICS_UNAVAILABLE`；报告保留可用组件，并返回带有 `DIAGNOSTICS_INCOMPLETE` 的 HTTP 503，而不是编造事件。参见[仅记录元数据的实现](src/edge-diagnostics.mjs)。

## 仓库与 GitHub 代理

`/_host/repo` 和 `/_host/github` 要求所有者身份验证、精确同源请求及已完成的成对引导初始化。GitHub 操作固定面向 `your_org_x/your-node`；源代码发布以 `main` 为目标。仓库的 `read`、`tree` 和 `diff` 覆盖 seed organ 以外获准的源代码路径；在线 MIRROR 读取保留独立且更窄的路径策略。私有记忆不能作为 GitHub 回退读取或发布的来源。路径和内容检查会保守地拒绝私有或疑似秘密的数据，也可能拒绝正常的源代码文件。发布文件名和内容会在批准或网络调用前接受检查；完整序列化的代理结果也会接受检查。允许的路径和请求字段参见[代理实现](src/cloud-brokers.mjs)。

这个仓库是节点自己的。`sync_head_to_github` 会在一次提交中把本节点的 head、其 organ 模块、`mirror/home/auma/HANDOFF.md` 和 receipt 账本提交到该仓库的 `main`，因此请把仓库设为节点自己的私有仓库，绝不要设为共享的源代码仓库。有两处会安全地失败：占位符所有者 `your_org_x` 在 GitHub 上不可能存在（登录名不含下划线），所以未经修改的节点到达不了任何仓库；当配置的仓库是共享的 `aukora-x7` 时，边缘端会以 `HEAD_SYNC_SHARED_REPOSITORY` 拒绝 head 同步。

源代码读取和差异比较会解析不可变提交 SHA，并验证 Git 树模式、祖先目录及普通文件条目。历史提交元数据和差异基准必须通过针对固定 `main` 的有界祖先关系比较；调用方不能选择 SHA 作为差异目标。读取上限为解码后 256 KiB。树结果公开 `treeSha`、过滤及截断标志，并从一次有界递归响应中最多返回 1,000 个条目，投影条目预算为 96 KiB，不能保证清单完整。GitHub issue、PR（Pull Request）、评论及工作流读取采用有界分页；必须保留 `moreMayExist` 及差异／树截断信息。这些代理不会静默遍历全部分页，也不会跟随任意引用、符号链接或子模块。

仓库的 `write`、`commit` 和 `push` 通过预期 head 比较来发布明确的源代码载荷。每次发布都需要通过所有者 Touch ID／passkey 流程取得精确、单次使用的 Class 3 批准，并绑定目标和完整请求内容。GitHub 的 `action: api`、`method: POST` 仅允许在 `/repos/your_org_x/your-node/issues` 使用 `title` 和 `body` 创建 issue，或在 `/repos/your_org_x/your-node/issues/N/comments` 使用 `body` 创建评论，且须满足相同批准要求。创建评论时会验证 `N` 是 issue，并拒绝 PR 编号。登录或已配置的 GitHub token 不代表发布同意；源代码发布既不选择正在运行的 HEAD，也不部署它。

绝不自动重试结果不确定的外部修改。源代码在派发后的失败，包括输出检查失败，返回 HTTP 503，并包含 `REPO_PUBLICATION_OUTCOME_UNKNOWN`、`outcome: unknown`、`retry: repeat-the-identical-request-to-reconcile` 和 `requiresFreshClass3Approval: true`。此提示仅允许为同一请求重新取得批准后有意核对结果，不允许自动重新提交。有界提交历史中没有标记，不能证明请求未执行。

issue／评论在派发后的失败返回 HTTP 503，并包含 `GITHUB_MUTATION_OUTCOME_UNKNOWN`、`outcome: unknown`、`retry: inspect-github-before-new-approval`、`requiresFreshClass3Approval: true` 和 `replaySafe: false`。这些操作不提供幂等性保证。在请求新批准或再次提交任何内容前，先检查 GitHub。

## 源代码字节与状态比较

携带 `action: bytes` 的 `POST /_host/repo` 接受 `path` 及可选的 `offset` 和 `length`，默认值分别为 0 和 256 字节。切片上限为 4,096 字节，文件大小不得超过 256 KiB。该操作仅从已固定提交的 GitHub `main` 读取获准的远程源代码子集，绝不读取在线 MIRROR 或私有记忆。它在返回任何字节或摘要之前，检查完整 UTF-8 文件中的秘密信息和无效控制字节，并验证 Git blob hash。结果包含固定的 `commitSha`、`blobSha`、总大小、实际切片长度、整数数组 `bytes`、`hex`，以及带有 `hashScope: whole-file-original-bytes` 的全文件 `sha256`。原始字节，包括 UTF-8 BOM，均予以保留。偏移量等于 EOF 时返回空切片；超过 EOF 时拒绝请求。

同一端点携带 `action: state_diff` 时，接受可选的完整 `base`，其中包含 `head: {ballId, epoch}` 和 `mirror: {lineageId, revision}`。HEAD 在同一个存储事务内比较已保留并验证的 manifest。保留记录不能证明调用方的基准曾被选中、是当前 HEAD 的祖先，或属于经过证明的 lineage。每份 manifest 上限为 256 KiB 和 256 个条目；响应最多公开 100 个变化条目的 ID 及 `added`、`removed` 或 `modified` 状态，同时提供 `total` 和 `truncated`。它不返回模块正文、配置值或文件内容。MIRROR 仅将当前 lineage/revision 与调用方提供的 lineage/revision 比较；调用方提供的信息不能证明历史内容。由于 HEAD 和 MIRROR 的观测彼此独立，合并报告明确设置 `atomicAcrossBindings: false`。

未提供基准时，`basis: snapshot-only` 返回当前标识，变化指示值为 null，条目比较不可用，而非零变化。所请求的比较缺少已保留的基准或元数据时，返回带有 `STATE_DIFF_INCOMPLETE` 的 HTTP 503，并保留可用观测；不可用条目比较的变化和计数为 null。格式错误的基准返回 HTTP 400；已保留 HEAD 的 epoch 不匹配，或当前 MIRROR lineage 中的未来 revision，返回 HTTP 409。这些读取保留现有身份验证、同源和引导初始化检查，不授权发布或提升。参见[有界状态投影](src/state-diff.mjs)。

## 公共 HTTPS 读取

经过所有者身份验证的同源 `POST /_host/web-eyes` 携带 `action: fetch` 和 `url`，仅在实际 Cloudflare 运行时将 `global_fetch_strictly_public` 和 `no_cots_on_external_fetch` 都报告为 true 时，选择通用公共 HTTPS 读取。适配器捕获全局 fetch，并依赖 Cloudflare 生产环境在 DNS 解析后执行的公网地址限制及默认外部 TLS 信任，而非应用层 IP 固定或 DNS 预检查。本地 Miniflare 网络不能建立这一保证。源代码和合成检查不能证明生产环境已经激活此能力。

[生产部署启动器](../../server/deploy-cloudflare.mjs) 默认或在使用 `--print` 时只打印固定计划，不启动子进程，也不构建、上传或部署。只有显式 `--deploy` 才会携带两个兼容性标志启动固定版本的 Wrangler 4.159.0；生产部署仍须单独授权。固定的空 `--env-file` 明确阻止加载项目 `.env` 文件。供本地开发使用的规范 Wrangler 配置不包含这些标志。运行时标志不能证明环境是生产环境：强行在本地模拟环境中启用它们不受支持，也不能获得生产环境的公网地址保证。

通用读取接受公共 DNS 主机名和不含秘密的查询参数，同时拒绝 IP 字面量、本地或元数据服务主机名、非标准端口、部署自身的主机、URL 凭据和片段。请求使用匿名 GET 和固定标头，不携带调用方身份验证信息，不跟随重定向，也不自动重试。响应必须是完整的 UTF-8 HTML、纯文本、JSON 或 XHTML，不得压缩或包含 NUL 字节。完整响应体和代理 JSON 结果分别以 256 KiB 为上限，因此封装开销会降低内容的实际可用上限。十秒传输期限涵盖标头和响应体。

缺少这些运行时标志时，独立的 `trustedDocsHttpsFetch` 回退路径仍严格限于 `https://api.github.com`、`https://developers.cloudflare.com`、`https://developer.mozilla.org` 和 `https://registry.npmjs.org`，且仅允许 GitHub 的数字 `page` 和 `per_page` 查询参数。它信任这些提供方的 DNS 和平台 TLS，不承诺对任意目标强制执行公网地址限制。结果标明 `capability: public-web-fetch` 与 `networkPolicy: cloudflare-global-fetch-strictly-public`，或 `capability: trusted-docs-fetch` 与 `networkPolicy: trusted-origin-allowlist`。健康报告公开 `capabilities.publicWebFetch` 和 `capabilities.publicWebNetworkPolicy`；selftest 公开 `brokers.webEyesConfigured`。

代理检查原始、解码后及规范化后的出站 URL、返回文本和完整序列化结果，拒绝可识别的秘密信息及已配置凭据值；疑似身份验证用途的查询键也会被拒绝。这些检查属于纵深防御，并非对调用方选择的路径或内容的普遍隐私保证。读取权限不授权上传、外部写入、凭据披露或部署。两种策略参见[传输实现](src/public-https-transport.mjs)。

## 提供方兼容性与未知结果

现有 `/door/anthropic/v1/messages` 和 `/door/openrouter/v1/chat/completions` 路由保留各提供方的请求格式和模型 ID，并使用服务器持有的凭据。合成模型 ID 测试仅验证协议格式（wire format）／schema 兼容性，不能证明模型线上可用、账户有权访问或付费请求成功。现有内联图像处理保持不变。

结果不确定的请求派发失败返回 HTTP 422，并包含 `x-should-retry: false`、`code: PROVIDER_OUTCOME_UNKNOWN`、`outcome: unknown`、`retry: do-not-repeat-automatically` 及嵌套的 `error.type: provider_outcome_unknown`。已预留配额仍计为已用，Worker 自身绝不重发请求。现有默认 LLM（大语言模型）客户端将此 422 视为终止错误；显式配置的 `mode: always` 重试策略仍可覆盖这一行为。重用已分派的轮次 ID 会被拒绝；新轮次 ID 不会对相同意图去重。在有意重新提交前应先检查不确定的结果。参见[重试迁移指南](../../docs/upgrade-guide/v0.2.2-alpha.2/round35-cloud-capabilities/guide.zh.md)。

## 部署、归档报告与恢复限制

部署工作流始终要求通过源代码、权限、构建、产物和 bundle 检查。仓库未配置 `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_ACCOUNT_ID` 秘密时，会跳过发布并在步骤摘要中明确说明，不会宣称部署成功。只有 Wrangler 报告发布成功后才运行观察任务。已配置的部署失败、main 已更新以及检查失败仍会导致工作流失败。

经过所有者身份验证的 `GET /_host/estate`，以及携带 `{ "action": "archive_status" }` 的 `POST /_host/estate`，对固定的 `snapshots/`、`modules/` 和 `files/` 前缀分别最多读取 64 行对象元数据。每个前缀的计数和字节总量仅涵盖已观察的页面；截断和省略名称会明确标示。`prefixSummaryComplete` 仅涵盖这三个固定前缀；现有的顶层 `truncated` 和 `omittedObjectCount` 字段仅描述快照。响应不会披露内容对象键或快照载荷。`backupStatus` 区分 `unconfigured`、`empty`、`no-latest-pointer` 和 `snapshot-present`；由于元数据存在并不等于完成恢复演练，`integrityVerified` 始终为 false。estate GET 还通过 `latestMatchesSelectedHead` 比较已观察的最新快照与所选 HEAD 的 epoch 和 ball ID。这些观察不能证明多个独立存储之间存在原子快照。

`POST /_host/aumlok/redeem` 仍仅执行经过身份验证的邀请码验证：请求包含已签名的邀请回执及其 32 字节 base64url 邀请码。七个单词是所有者保留在本地的恢复秘密，不是邀请码，绝不能提交。验证成功不会授予 cookie、会话、注册资格、消耗邀请或 Class 3 权限；`guestAccess` 明确报告 `GUEST_ACCESS_UNAVAILABLE`。启用访客访问前，必须先提供独立的签发方、隔离的资源和能力路由。

整库恢复仍有十项未完成的验收要求。隔离的真实存储测试表明，即使外部观察记录仍然存在，整个存储回滚后仍可重放发布；身份行回滚可使已消耗的批准重新生效；时钟回滚可使已过期的批准重新生效。这些测试复现的是缺陷，并不代表通过恢复验收。仍需实现独立的接纳见证、所有者恢复 epoch、持久化时钟和节点检查，以及运行时祖先关系适配器。

## 语音桥、提供方轮次、闸门与签名动作

原始 PersonaPlex WebSocket 桥接现在会拒绝连接并返回 `VOICE_RENDERER_PROTOCOL_UNSUPPORTED`，即使已配置其 URL 也不例外。当前渲染器没有经过验证的帧协议来强制执行已记入日志的会话、状态槽、语句队列或空闲指令。当 `bridgeAvailable` 为 false 时，应保持语音控件不可用。语句验证使用针对性的拒绝列表，不能保证任意文本都不含秘密。状态槽只在 UTF-8 码点边界截断。

提供方 HTTP 请求现在由 HeadDO 执行，前提是通过精确的持久化轮次日志接纳检查。从请求发起到流完成期间，插话、放弃、替换及请求取消都会中止所属的上游控制器。已分派和已取消的轮次 ID 不可重试，即使包含 256 行的日志窗口已淘汰其文本也不例外。索引墓碑记录保持持久化；不提供自动裁剪或重试。分派后的传输失败仍属于结果未知。只有在独立发起一项有意执行的操作时才创建新轮次，绝不能借此重试结果不确定的副作用。

所有者登录、AUMLOK bind/approve 及受保护的提升检查，在一分钟内前四次失败时保留原始失败状态，第五次返回 `429 GATE_LOCKOUT_ACTIVE`。持续五分钟的锁定在对象重新创建后仍然有效。登录计数桶使用经过哈希处理的 Cloudflare 调用方 IP；缺少 IP 的请求共用一个后备计数桶。Head 检查按经过身份验证的主体和操作区分，将副作用串行执行，并让携带 Class 3 token 的直接 ball 发布共用提升计数桶。成功会重置尚未锁定的失败记录。签名凭据或 passkey 的要求均未削弱。

在相同父级和 epoch 上暂存不同候选项，必须显式设置 `replaceStaged: true`；相同内容的暂存会保留 `stagedAt`。发布会在其事务内检查当前候选项，包括提升操作已取得较早候选项之后的情况。发布结果在对象重新创建后仍然保留。只有完整证据提供了布尔值时，Aura 才会公开 `handOffEpochMismatch`。

暂存、提升和 ball 发布会验证可选的 `x-x6-signed-action` JSON 或顶层 `body.signedAction` 封装；同时提供两者会被拒绝。混合签名载荷使用 `head.stage`、`head.promote` 或 `head.publish`，包含当前父 HEAD 的 `ballId` 和 `epoch`，并将请求的精确源设为 `audience`。其 `targetDigest` 是规范 JSON `{ method, pathname, body }` 的 SHA-256，其中 `body` 是仅移除顶层 `signedAction` 后的完整 HTTP JSON 请求体。因此，租约字段和显式暂存替换标志若存在，也会纳入签名。独立配置的所有者 Ed25519/ML-DSA 密钥用于验证封装身份。签名操作绝不能代替会话或 Class 3 WebAuthn 批准。其持久化单次使用键与成功的暂存／发布原子提交；验证失败不会消耗该键。

离线回归命令为 `node --test deploy/cloudflare/src/__tests__/*.test.mjs deploy/cloudflare/src/__tests__/worker.spec.ts`，以及 `node --import tsx/esm --test deploy/cloudflare/src/__tests__/owner-login-lockout.spec.ts`。fixture 将合成的提供方传输注入 HeadDO。这些测试不能证明已部署 Cloudflare 的行为、实际 GPU／音频延迟或所有者验证仪式已获接受。生产环境部署仍是所有者的独立操作。
