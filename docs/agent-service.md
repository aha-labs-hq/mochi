# 服务 Agent 的运行环境

2026-09-23，用户要求把系统建设视为服务业：Agent 应能理解目标，自行取得证据、组合基础动作并交付结果。比价只是测试案例，不是新增场景分支的依据。用户随后明确授权按照 Pi 官方文档拓展基础执行和联网能力，取代此前“只解释能力缺口、不接入网页”的实施范围。2026-09-28，Pi SDK 升级到 0.87.1，并把公开网页搜索和正文读取作为 Mochi 自己审计的一等工具接入。2026-10-10，Pi SDK 升级到 1.1.0，ChatGPT 订阅由此提供 GPT-6.1 Sol。连接器从当前 GitHub 专用工具迁移为开放 provider registry 的目标合同见 [connector-architecture.md](connector-architecture.md)；本文的执行沙箱和 Pi 边界仍然适用。

## 所有权与基础能力

Pi 1.1.0 的 SDK 文档声明默认工具是 `read/bash/edit/write`，并提供工具工厂、自定义 operations 和扩展边界。Pi 0.99 起内置的 codemode、tool search、MCP 与 llama.cpp 扩展只由 CLI 注入；SDK Session 只从 Mochi 的隔离 ResourceLoader 取扩展，因此一个也不加载。bash 的非零退出现在作为 `isError` 结果交给模型而非抛错；网页研究与沙箱边界自检都把它当作失败。官方 sandbox extension 示例使用 `@anthropic-ai/sandbox-runtime` 包装 bash。Mochi 使用同一边界，把四个原生工具整体放入 macOS 沙箱子进程，复用 Pi 的参数 schema、编辑语义、图片读取、输出截断和续读信息。初始化失败直接关闭本次执行，不采用示例中的无沙箱回退。

原生 read 显式使用 SDK 的 `autoResizeImages: false`，与现有 material_read 一样交付原始图片；不依赖未随单文件程序发布的可选 Photon WASM。图片仍受模型输入与进程输出大小限制，这不代表新增 PDF/Office/视频解析器。

参考：固定依赖的 `docs/sdk.md`、`examples/sdk/05-tools.ts`、`examples/extensions/sandbox/index.ts`；[Pi 官网](https://pi.dev)；[sandbox-runtime](https://github.com/anthropics/sandbox-runtime)。sandbox-runtime 固定为 0.0.77，随 worker 打包并生成许可证清单。

`sandbox-runtime` 间接依赖的 `node-forge` 固定在已修复 GHSA-86w9-cpqp-85rv 的上游提交，另有本地补丁；理由与升级检查见 [`patches/README.md`](../patches/README.md)。

| Agent 需要的服务 | 唯一所有者 | 行为 |
| --- | --- | --- |
| 理解委托及来源 | `messageEvidence.ts`、`runtime/instructions.ts` | 当前请求、引用与背景分开；背景不产生授权。每个回合写明群、时间和发言人，见[上下文与出处](#上下文与出处)。 |
| 发现动作 | Pi 实际注册的工具 schema | 不维护第二份可用/不可用能力目录，不按任务名称分派。 |
| 通用执行与联网 | `runtime/execution.ts`、`executionSupervisor.ts`、`executionRunner.ts`、`webResearch.ts` | 提供 Shell、curl、系统工具与打包的 Bun；`web_search` 定位公开来源，`web_fetch` 读取公开正文，所有请求仍在本次 turn 的沙箱代理内。 |
| 已授权项目工作 | `connectors/github/`、GitHub connection 与 Issue workflow | 已迁移：GitHub 与飞书注册在同一个 Broker，模型只看到四个连接器工具。已选仓库与当前人类授权的绑定不变，凭据仍不进入执行环境。 |
| 持续推进 | Pi AgentSession | 同一永久 Session 的工具循环、steer 与原生压缩；宿主不重放任务。 |
| 交付与可见反馈 | 自然语言结果、`messageFeedback.ts`、Issue workflow | 操作结果与整个请求是否完成分开，不把回合结束当作任务成功。 |

## 执行环境

每个 Bot 仍由不同于 Bridge 的 OS 用户运行固定、root-owned、digest-pinned worker。worker 拥有模型账号与永久 Session，工具子进程只拥有当前 turn 的执行环境：

- `.pi/mochi/bots/<botId>/execution/turn-*` 为私有可写 scratch；当前 turn 的已发布材料只读。只有必要系统运行库、系统工具、系统 CA 和精确 worker 可执行文件可读。原生 read/write/edit 与 bash 受同一个 OS 沙箱约束，包含 symlink 解析后的路径。
- 工具没有账号文件、Session、其他 Bot 状态、Bridge 凭据、用户私人文件、ambient 环境变量、Skill、扩展或 MCP。Bun 使用已打包可执行文件的官方 `BUN_BE_BUN=1` 模式，无需用户安装运行时。它同样在沙箱内。
- 网络只能经过沙箱代理访问公开主机的 80/443 端口；直接网络和 IP 字面量不开放，localhost 的任何写法（大小写、末尾点、`*.localhost`）在准入时拒绝。代理拨号时重新解析域名并固定到通过检查的地址，只拨全球可路由的单播地址：私有、共享（CGNAT）、本机、链路本地、基准测试（198.18.0.0/15）、文档、组播与保留地址，IPv6 全球单播 2000::/3 以外及其中的非全球地址都拒绝，携带 IPv4 的 IPv6 形式按其 IPv4 判断；`executionNetwork.ts` 的 `NON_PUBLIC_ADDRESS_RANGES` 是唯一清单。重定向的每一跳都是新的代理请求，按同一规则判断。worker 若继承 `HTTP(S)_PROXY`，sandbox-runtime 会把解析交给上游代理并跳过地址检查，因此执行环境直接拒绝启动。TLS 校验使用系统 CA，不能为通过测试关闭证书验证。
- Clash Verge/mihomo、Surge、sing-box 等代理的 fake-IP（TUN/增强）模式把所有域名解析到 198.18.0.0/15，本机看不到真实目的地；代理之后按自己的规则直连局域网或经远端节点访问其本机。准入阶段一旦看到 fake-IP 应答就拒绝：bash 结果附加说明，`web_search`/`web_fetch` 在本 turn 内直接失败并返回同一说明——本 turn 无法联网研究，需由 Mac 所有者把代理 DNS 改为真实 IP 模式（mihomo `dns.enhanced-mode: redir-host`）或关闭 TUN/增强模式；Mochi 不修改代理设置。worker 日志每 turn 记录一次 `runtime.execution.fake_ip_refused`（含主机名）。用独立 DoH 取得真实地址再按 IP 拨号的方案不采用：它要把每个访问的主机名交给第三方解析服务，大陆与海外可用的端点不同，按 IP 拨号会绕过代理按域名的分流，而开启嗅探并覆盖目的地的代理仍会按域名重新解析。同一嗅探覆盖在真实 IP 的 TUN 模式下也会让最终目的地偏离已核验地址，这是剩余风险。
- sandbox-runtime 的代理与策略是进程级单例：`reset` 后保留上一 turn 的策略却没有代理，从未初始化时则不限网络与读取。TurnExecution 以进程内租约保证同一时刻只有一个 turn 持有它，第二个 turn 在触碰执行根目录前就失败；每条命令包装前核对单例仍持有本 turn 的配置对象与代理端口，否则失败关闭。
- 公开网络不是认证浏览器或搜索服务保证。Agent 可以读取公开网页、API 和公开搜索页面，遇到登录墙、限流、机器人校验或需要网页交互时必须如实报告。执行环境不继承浏览器登录态，技术可执行不代替外部写入授权。
- `executionSupervisor.ts` 独占一次工具调用的进程组与清理。它是同一签名程序的受信入口，只接收最小环境与闭合内部请求，不运行模型代码、不读账号或 Session。命令先等待私有管道；worker 记录精确进程组并通过独立 IPC 确认后才执行。worker 死亡使 IPC 断开，监督进程清理整组；监督进程死亡由仍在的 worker 清理已确认进程组。未确认的命令不可能执行。不存在按 UID 或名称扫描、清理其他 Bot 的路径。
- sandbox-runtime 的固定补丁拒绝 Darwin 的 `setpgid`、`setsid` 与 `posix_spawn`，后者能绕过前两者的调用入口改变进程组。普通 bash 命令、fork/exec 和管道保留；Bun/Node 的 posix_spawn 子进程 API 明确报 EPERM，工具描述要求通过 bash 启动系统命令，不另加无沙箱兼容执行。初始化用真实非组长进程复验全部三条路径，失效即关闭本次执行。
- bash 执行与 Pi 结果格式化分别运行在同一策略的沙箱内。输出截断文件不能交给沙箱外写入，因为模型可能已把 scratch 的 tmp 改成指向私有目录的 symlink。
- 命令最长 120 秒，子进程输出最多 32 MiB；Pi 把长输出截断并保存到同一 scratch，模型可继续读取。整个 turn 仍受 Bot 的 `turn_timeout_seconds` 约束。
- 正常结束、取消和关闭等待执行进程退出并清理代理与 scratch；崩溃遗留 scratch 由同一 Bot 持有 runtime.lock 后在下次使用时清理。文件不持久交付，最终回复不能把临时路径冒充下载附件。所有工具后代都被内核限制在原进程组内；这不是 CPU、内存或磁盘的独立配额。

### 公开网页研究

`web_search` 和 `web_fetch` 是编译期固定的受控工具，不加载第三方 Pi Extension、Skill、MCP 或浏览器 Cookie。搜索通过公开搜索页面取得有限标题、链接和摘要；读取工具只接受绝对 HTTP(S) URL，返回页面正文、内容类型、原始 URL、取得时间和截断标记。搜索结果是定位证据，关键结论必须再读取原文；价格、时效、政策等易变事实应交叉核对独立来源。HTML 会在沙箱中读取后做有界文本化，脚本、样式和 SVG 不进入模型；登录墙、验证码、限流、动态渲染或页面失败都会作为缺口返回，不能用记忆补齐。搜索先用 DuckDuckGo；它失败或没有结果时只换 Bing 一次，因为 DuckDuckGo 在大陆无代理时不可达。结果的 `provider` 与 `fallback.reason` 标明来源和原因，worker 日志记录 `runtime.web_search.fallback`；两者都失败时报告两者的原因，fake-IP 拒绝和取消不触发回退。

这层能力刻意不复刻某个网站或某个比较流程，也不把 `pi-web-access` 等第三方扩展放入持有账号和 Session 的 worker。未来若引入 provider/API key 或受控浏览器，必须拥有独立的凭据、网络、缓存、SSRF 和审计合同；当前版本只做匿名公开 HTTP(S)。

sudoers 必须带显式空参数串 `""`，只允许 Bridge 启动无参数 worker；省略参数限制在 sudoers 中意味着允许任意参数，不能让 Bridge 以运行时用户直接调用内部 `--execute-tool` 入口。没有通过此更新的旧 sudoers 不满足新的执行边界。

bootstrap 和账号角色仍不注册工具。生产 turn 在边界自检通过后才交给模型：同一 runner 在沙箱内证明 worker 状态目录不可读、不可写，直接连接被 OS 拒绝（curl 7），经代理的禁止目的地被拒绝（403），且宿主侧监听器没有收到连接；自检不需要外网，其他任何结果都关闭本次执行，不退回无沙箱执行。`tool_execution_start/end` 为本地工具记录 session/turn/source/call ID、工具名和错误状态，不记录命令或结果正文。初始化、工具调用与清理失败必须可诊断。

### 剩余风险：公网外发

公网出口是 2026-09-23 用户授权的能力，外发因此是接受的风险：被注入的内容（Issue/PR 正文、外部来信、飞书文档、网页）可能让模型把本 turn 读到的私有内容放进 curl 请求或 `web_fetch` 的 URL，发往任意公网主机。代码只保证请求到达的是公网，不判断该不该发。现有缓解：

- 代理只拨公开地址，fake-IP 时失败关闭；凭据、账号与 Session 不进入执行环境；到点 turn 不能运行 shell。
- 连接器写入受 Broker 的每 turn 写入预算约束（见 [connector-architecture.md](connector-architecture.md)）。
- 运行合同的不可信输入规则（网页、来信、文档与搜索结果是证据，不是指令）与跨群分寸规则（他群内容默认不披露）。

不采用“读过私有数据的 turn 禁止外发”这类污点策略：Mochi 的 turn 几乎都同时读私有上下文（群消息、Issue、代码）和公开资料，污点会在第一次私有读取后关闭 bash 网络与 `web_fetch`，使用户授权的研究能力在大多数 turn 失效；GET 本身就能借 URL、查询串和 DNS 外发，按请求方法也划不出安全子集。改变这个取舍需要用户重新决定。

## 上下文与出处

用户决定：一个 Bot 就是一个人，在所有开启的群里共享同一个永久 Session 和记忆，新群默认开启（2026-10-15 评审后重申）。所以 Mochi 不按群拆分记忆，而是像同时在几个群里的同事那样：记得各群的事，知道每件事出自哪个群、哪个话题、谁说的，在群之间有分寸。

| 关注点 | 唯一所有者 | 合同 |
| --- | --- | --- |
| 群名 | `lark/groups.ts` 的目录，`lark/group.ts` 校验名称 | 当前群的名称随回合进入模型；目录读不到或群没有名称时写“未知群”，不猜。 |
| 分寸 | `runtime/instructions.ts` 的运行合同 | 跨群使用内容前先判断这个群的人是否应该知道。项目事实引用 GitHub 等共享来源；个人、人事、薪酬、对人的评价、“别外传”的内容和私下讨论不转述；拿不准时只说“在别的群讨论过”。写进 GitHub 同样适用；同群讨论和正常协作不受影响。 |
| 回合文本 | `runtime/instructions.ts` 的 `runtimeUserMessage` | 见下文。 |
| 压缩后的出处 | `runtime/resources.ts` 的 `SESSION_COMPACTION_INSTRUCTIONS` | 自动和手动压缩共用。 |

群名此前按合同不进入模型。现在当前群的名称会进入模型上下文，因为只有不透明的 chat ID 时，模型既说不出一件事是在哪个群讨论的，也无法判断跨群转述是否合适；压缩之后各群内容还会混在一起。名称由 `group.ts` 限长并拒绝控制字符，不能伪造回合结构；它只是同一群消息正文旁边的一个标签。群名和头像仍不进日志与诊断导出，日志只记稳定 chat ID。

### 每个回合的文本

系统提示按 Session 固定：内容一变，worker 就要 reload Pi，提示缓存也会失效。所以随回合变化的事实放在回合消息里。`runtimeUserMessage` 把一条飞书消息写成人能读的文本：

- 开头：群名、当前时间（本机时区和 UTC 偏移）、发言人，以及所在话题（起始消息摘要和发起人）。
- 依次是引用的原文、当前话题最近至多 10 条（合计 8,000 字符以内，更早的在话题证据里）、本群近期至多 12 条背景。每条写成“发言人 时间：正文”；多行正文的后续行缩进，别人的消息不能冒充段落标题。
- 材料清单：类型、来自哪条消息、送达状态、第几张图片输入和路径。图片仍作为 Pi 原生图片输入。
- 证据文件：话题证据（`topic-evidence-NN.json`，schema 2 不变，是 Issue 引用原话的权威来源）和来源索引（`sources-NN.json`，含群、消息和发言人 ID 以及原消息链接）。两者都在 turn workspace 内，turn 结束删除。
- 最后是当前消息原文，只出现一次且保持精确，供 `authorization_quote` 逐字匹配。

工具调用的来源仍由 Pi 事件中的 sourceMessageId 绑定（`turnProvenance.ts`），不读取回合文本。定时回合由 `schedules/prompt.ts` 生成，同样以群名和时间开头，并自带定时专属规则；交互回合的系统合同不再包含这些规则，worker 的执行策略仍独立拒绝写入和执行工具。

以 o200k 计，12 条短消息的典型回合从 3,252 tokens 降到 452，运行合同从 2,178 降到 1,946，四个协议文件从 3,817 降到 3,391；定时回合消息因带上专属规则从 269 增到 380。

### 消息读取与材料预算

这些实现细节只给维护者看，模型可见的语义在 `config/protocol/message-contract.md`。

- `messageEvidence.ts` 读取当前消息、同群至多 8 条引用祖先、当前话题（至多 200 条、256,000 字符，单条 8,000 字符）和近期背景。近期背景只刷新本进程已观察、当前群的至多 12 个消息 ID，不进入 Issue 证据。
- `messageContent.ts` 按官方 lark-cli v1.0.93 converters（`shortcuts/im/convert_lib`）独占 compact 内容解码：在正文截断前提取材料引用，每条消息至多 64 个去重引用（超出记 `message_material_reference_limit`）；纯文本里像资源的文字不触发下载。
- `messageHydrator.ts` 产出唯一材料清单：每次准备至多 8 个消息资源和 4 个文档链接，单个资源 5 MiB、单个文档 JSON 2 MiB，共享 12 MiB；未完成 turn 的 staging 合计 64 MiB。准备总时限 60 秒，近期刷新至多用其中 15 秒。Doc/Docx 由 `drive +inspect` 和 `docs +fetch` 读成 JSON。

### 压缩后保留出处

Pi 1.1.0 默认的摘要模板面向编码代理（目标、进度、文件路径），没有群的维度。自动压缩也不接受自定义指令：`_runAutoCompaction` 固定传入 `undefined`；官方唯一的扩展入口 `session_before_compact` 要求扩展自己生成整份摘要。为了不在 worker 里重做 Pi 的鉴权、拆分回合和重试，`patches/@earendil-works%2Fpi-coding-agent@1.1.0.patch` 只加了一个设置 `compaction.customInstructions`：自动压缩像手动 `compact(customInstructions)` 一样，把它作为 “Additional focus” 接在 Pi 的模板后面。`runtime/resources.ts` 的 `isolatedSettings` 和手动整理都使用 `SESSION_COMPACTION_INSTRUCTIONS`：每条重要事实保留【群名 · 话题 · 发言人】，按群分组，私下或敏感内容标〔私下〕，项目事实记下共享来源，这样分寸规则在压缩后仍然有据可依。Pi 的拆分回合前缀摘要不接受自定义指令，但它只覆盖当前这一个回合，而回合开头已经写明群名。升级 Pi 时先确认该设置仍然生效或已有官方等价能力，再删除补丁。

## 到点工作

[安排](schedules.md)是受信任宿主产生的独立 `scheduled` turn，仍使用原永久 Session，但不把旧人类消息当成新的写入授权。worker 10 从宿主执行策略拒绝该回合的 `connector_write/bash/edit/write` 及 steering，Bridge 的目录/读取只允许明确绑定并仍有效的资源。`read` 和闭合公开研究工具继续可用；关闭 scratch 写入防止替换研究子进程的 PATH 命令。普通人类 turn 的通用执行合同不变。模型完成不等于消息送达，安排只在验证 Bot、同群、目标话题与消息回执后记录已发出；不声称已读或整件事完成。

## 会话与交付

Issue 写入的语义判断属于 Pi Agent：它决定是否已有足够事实、是否需要追问以及是否复用重复候选。Bridge 不把先读取一次或固定确认轮次当作授权门槛；强类型写入负责目标校验、幂等和权威回读。

四个工具属于 worker 内建能力，与材料工具一样不经过 Bridge relay，不改变连接器工具的 capability ABI。更新不创建、替换或 fork 永久 Session，不改写历史 JSONL，不覆盖 Bot 保存的嘱咐。真实工具声明与当前 turn 的环境描述是能力事实，旧对话中的“不能联网”不应成为新的权限定义。

模型是唯一自然语言理解层。协议中的例子不是任务白名单，不要求人类提供工具步骤，不把评测问题写入提示词。缺少同名专用工具时应判断基础动作能否组合完成；已经能取得的证据自行取得，只有会改变结果且只能由用户决定的信息才提问。

证据按需闭合：定位查询返回稳定标识、链接与有界片段，完整规则用相应读取工具取得。附件、公开网页与客户项目各有来源；不能用行业惯例补齐未知项目规则，也不能把链接、搜索摘要或模型记忆当作已经读取的原文。

`ToolTurnState.issueOutcome` 从 null 开始，只有 Issue 门禁/工作流真实执行才产生 completed/waiting/blocked。`issueWorkflow.ts` 合并同话题 steer 批次的结果，不跨话题继承；waiting 表示重复候选等仍需模型判断的状态，不是所有写入都必须等待用户确认。`MessageFeedback` 串行管理 OnIt、Typing 和结束反馈；回帖后清除进度，THINKING/FROWN/ERROR 分别保留待判断、已知门禁和执行失败，不自动显示 DONE。局部成功不证明整个请求完成。

reaction 失败只降级可见性，不重放任务或阻止回复。`processed_events.completed` 和 `runtime.turn.completed` 只表示事件或模型回合结束。宿主不解析自然语言关键词判断任务成功，不增加任务分类工具、二次模型审判或第二套对话状态库。

## 验收

确定性检查覆盖原生工具组合、材料只读、凭据/外部路径与 symlink 拒绝、打包 Bun 的同等隔离、长输出续读与删除、直接和代理本机连接拒绝、执行取消/关闭和启动失败，以及边界自检失败关闭、上游代理拒绝、单例租约与策略核对、非公开地址清单、localhost 写法和 fake-IP 拒绝及其说明；网页研究检查搜索结果的来源链接、跟踪跳转、HTML 清理、非 HTTP 链接拒绝，以及回退的来源与原因。固定 Pi SDK 的 reload 检查覆盖原生工具与网页工具保留、历史和 Session 身份不变、one-at-a-time steering 与压缩设置。

真实行为验收必须使用新的公开调研问题，只提供目标，不指定工具序列；核对实际工具事件、取得的来源与最终结论。网络连通性检查、脚本化模型和历史聊天记录都不能替代这一步。部署后另外验证原永久 Session 恢复、模型登录、飞书监听与 GitHub 连接。具体执行证据随本次提交和 PR 记录，未实测的能力不能宣称完成。

评价标准是可核对的结果和减少无效往返；工具数量、调用次数、提示词长度和忙碌状态都不是成功指标。通用工具开放不保证任何网站可访问或任何任务必成功。

### 2026-09-25 Responses API 无 UI 验收

`script/test_byok_live.ts` 是需显式提供凭据的付费集成探针，不进入常规测试。它通过 stdin 接收连接声明，在临时私有目录使用生产 `ByokAccount` 完成真实验证、Pi 凭据保存、独立 ModelRuntime 读回和断开；随后运行真实 Pi AgentSession、生产 `executionTools` 与编译 worker 的沙箱执行入口。结束删除临时凭据、Session 和 scratch，不接触客户 Bot，不发飞书消息。

使用一个 Responses API 兼容服务的 `gpt-5.6-terra` 实测完成两个只给目标的任务：查询 Node.js 最新与 LTS 发布信息，以及调查 HTTP 429/503 与 Retry-After 的语义。前者发生工具错误后继续调用并取得官方发布索引；后者取得 RFC 6585/9110 并引用具体章节。两次任务各有两次成功工具调用，均交付含官方来源的最终答案。两次之间关闭并恢复同一测试 Session，身份保持不变；最后断开并读回 signedOut。

这证明了真实 Responses transport、工具循环、公开联网和同一 Session 恢复；不是原生输入表单、飞书交付、任意网站成功或任意兼容模型的证明。ChatGPT/BYOK 双向切换与逐 Bot 模型修复另有 BotApp 生命周期回归测试；生产永久 Session 与账号只在本地代码部署后做独立恢复核验。

本段记录的是此前 worker 8/status 22 的历史验证。当前源码使用 worker 10/status 28/control 23；新的验证结果以仓库验证收据和本次 PR 为准。
