# Grok Bot 与 Meta Muse 连接器 UX/UI 研究

日期：2026-09-29

这是一份产品研究，不是对 Grok Bot 或 Muse 的登录后实机验收。事实来自两家产品的官方帮助、产品和工程说明；无法访问的登录后页面不推断为已验证行为。

## 先纠正一个分类错误

`Grok Bot` 与 `Grok` 的通用连接器不是同一套入口。

- Grok 通用产品的 `grok.com/connectors` 明确分为 xAI 内置 OAuth、目录 OAuth、Custom MCP 三类。Custom MCP 才明确是 MCP；不能把这三类都叫 MCP。
- Grok Bot 的官方路径是应用内 Marketplace → Plugins。安装后在聊天中用 `@` 把连接器挂到任务，用 `/` 引用 Skill。团队策略在 Cursor Team Marketplace 的 Plugins 中管理。
- Muse 的连接器是产品级能力适配器。Meta 公开描述的是 API/CLI 原生连接器、Skill、Secure VM、Sentinel 和凭据代理；公开架构没有把 MCP 作为所有连接器的基础协议。Custom Connector 可以由 Muse 为 API/CLI 服务生成，目录连接器则经过 Meta 审核。

因此，`Skill` 是工作方法，`Connector` 是外部服务适配器，`MCP` 是一种工具协议，`Approval/Permission broker` 是授权裁决，`VM/Sandbox` 是执行隔离。它们不是可以互换的产品对象。

## 一条完整的用户旅程

| 阶段 | Grok Bot | Meta Muse | 对 Mochi 的启示 |
| --- | --- | --- | --- |
| 发现 | 用户先打开 Marketplace，浏览插件 | 用户可以在 Settings → Connectors 浏览，也可以直接说“连接我的 Gmail” | 入口可以由任务触发，但结果必须落到一个可检查的设置对象 |
| 接入 | Add 插件，再在浏览器中认证 | Connect → 阅读信息 → Continue → provider 登录/授权 | 连接前先说明能力、服务方条款、账号与范围 |
| 绑定任务 | 聊天中用 `@` 显式附加连接器 | 通常通过自然语言，Muse按任务判断是否使用 | 让模型决定编排，但能力身份必须是结构化、可审计的 |
| 运行中 | 对话显示工具活动、电脑画面、审批请求 | 聊天气泡、头像状态、Activity log、Goals/Upcoming、浏览器查看 | 结果、来源、当前状态和后续动作要连续可见 |
| 需要人 | Allow once / Always allow / Deny；密码、2FA、CAPTCHA 接管电脑 | Allow once / task / site / always / Deny；敏感输入在安全控件中完成 | 一次性授权与长期策略分开，敏感凭据不能进入对话 |
| 断连 | 卸载 connector，并在源服务撤销授权；共享电脑里的会话和文件仍可能存在 | Settings → Connectors 断开；已进入记忆和历史的内容不会自动消失 | 断开“未来访问”与清除历史/记忆必须明确分开 |
| 故障 | 插件被管理员禁用、供应商权限不足、登录过期，按错误状态恢复 | provider/浏览器/连接器由不同权限与日志表面承接 | 错误必须指出拥有者、影响范围和唯一恢复动作 |

## Grok Bot：工具优先、显式挂载

Grok Bot 的核心交互是“创建一个有职责的 Bot，然后在对话里给它任务”。官方安装连接器的步骤是 Marketplace → 浏览插件 → Add → 浏览器认证；接着用 `@` 把连接器附到任务。`/` 是 Skill 的入口。连接器可用时优先使用，因为它比网页点击更结构化；没有连接器或需要视觉流程时再使用浏览器。

这个设计的优点是任务边界清楚：用户可以看到当前任务是否显式带了某个连接器，Skill 也不会伪装成权限。缺点是用户需要理解 Marketplace、插件、`@` 和 `/` 的关系；对普通用户来说，“已经安装”与“当前任务会使用”是两个不同状态。

Grok Bot 的连接器是账号范围的，不是 Bot 范围的。所有 Bot 共用同一台云端电脑、文件、浏览器会话和命令行凭据；每个 Bot 的独立屏幕只是工作表面，不是安全边界。官方也明确提醒不要把两个 Bot 当作隔离边界。团队管理员的连接器策略在 Cursor Dashboard 的 Plugins 中管理，被阻止时在应用里显示 `Disabled by team admin`；成员可以在应用内发出访问请求。

授权与执行有三层体验：

1. 连接器安装/认证解决“这个服务能不能用”。
2. Auto Review 解决“这次工具调用是否按规则放行”。审批卡显示操作及输入，允许一次、永久允许匹配规则或拒绝；`Ask first` 优先于自动允许。
3. 密码、Passkey、2FA、CAPTCHA 和支付身份检查进入 Agent Computer 接管，用户完成后把控制权交回。支持的安全 secret 请求会遮蔽输入，并排除出 transcript 和模型。

它的故障恢复也有清晰分层：连接器供应商权限错误、登录过期和电脑不可达不是一个错误；电脑不可达才出现 Recover Grok Bot's Computer，Update/Reset 在 Settings → Updates。删除 Bot 不删除共享电脑文件和浏览器会话；删除连接器也不等于清理共享机器上的历史状态。

## Meta Muse：目标优先、渐进授权、持续监督

Muse 试图让用户不必先学习“连接器”这个概念。官方帮助给出两条等价路径：在 Settings → Connectors 中选择 Connect，先阅读说明再 Continue 授权；或者直接对 Muse 说“Connect my Gmail”。连接完成后，Muse 只交换完成任务所需的数据；帮助页举例，连接邮件允许搜索邮件，并不默认下载整箱邮件。能主动向 Muse 推送变化的连接器（例如日历）会在连接前标识。

Meta 产品页和帮助页把连接、权限、执行、审计放在同一个个人代理模型中：

- Settings → Permissions 可设连接器的 `Ask for some actions` 或 `Always ask`，并能继续进入每个 Connector 的权限管理。
- 写入、重要读取、发送邮件、日历邀请、购买等动作可以分别审批。审批选项包括一次、当前任务、当前网站、该连接器以后都允许、拒绝；`See task details` 在决定前展示更多上下文。
- 顶部头像显示实时状态；点击头像进入 Activity log 和 Upcoming；System Files 提供更深的活动检查。聊天不是唯一的状态面。
- 浏览器任务可在聊天中 Open browser，用户可以观察、Take control 暂停代理或 Stop the task 终止任务。密码进入 Secure Credentials Store，模型看不到。
- Meta 产品、第三方 Connector 和 Custom Connector 被明确区分。Facebook、Instagram、Threads 在同一 Accounts Center 时自动连接；Custom Connector 由 Muse 引导生成，但 Meta 明确说不审核其行为，用户必须谨慎授权。

Muse 的设计文章解释了为什么它要把活动、目标、审批卡和凭据做成确定性 UI：长时间后台工作不可见就无法信任，聊天不适合承载不可逆动作的最终批准。它还允许用户在连接后断开；但断开只阻止未来数据交换，已进入记忆和对话的内容仍在，需另外使用 forget 或 reset。

## 两套体验的判断

Grok Bot 在“把一个工具明确带进当前任务”上更强：`@` 是可见的作用域，Marketplace 也是可理解的发现目录。它适合熟悉工具的工作者。代价是插件安装、当前任务挂载、账号范围共享三件事容易被误认为是一件事，而且账号级共享连接与“每个 Bot 有独立职责”存在直接的心智冲突。

Muse 在“从一个目标逐步扩大代理权限”上更强：连接可以由任务自然触发，读/写权限、一次/任务/网站/永久批准、活动日志和目标追踪组成连续监督。代价是自然语言入口降低了发现成本，却增加了“我到底接入了什么、哪个任务会用到它”的查找成本；Custom Connector 未经 Meta 审核也必须在 UI 中显著警示。

两者都证明了一条边界：模型可以判断下一步、组合工具和决定何时需要解释；程序必须拥有凭据存储、连接范围、审批能力、运行隔离、来源身份、幂等和撤销。把这些门禁写进提示词会把产品责任交给不稳定的模型，反过来把每个低风险判断写成死状态机又会制造反复确认。

## 对 Mochi 的落地结论

### 先把对象分开

Mochi 的连接器层应该是开放集合，不应把 GitHub、飞书和模型并列成三项永久产品对象。更准确的分层是：

| 层 | 产品含义 | 当前判断 |
| --- | --- | --- |
| **Connector** | 外部服务的账号、资源和读写能力适配器 | 可持续扩展；GitHub、飞书文档/多维表/Wiki、Linear、Notion 等都属于这一层 |
| **团队共享上下文** | 连接器被优先用于理解项目全貌、事项和推进关系的场景 | GitHub 是 Mochi 当前最重要、最先打磨的推荐连接器，但不是特殊协议，也不是唯一上下文来源 |
| **消息入口 / 运行时通道** | 让 Bot 接收消息、参与话题、回帖和维持会话的通道 | 飞书群属于这一层；它有 Bot、群、话题和事件生命周期，不能与飞书 CRUD 连接器混成一项 |
| **宿主运行能力** | 模型连接、进程、Session、锁和状态发布 | 由宿主管理；不应被画成某个外部服务连接器 |

飞书因此必须在体验上分成两部分：**飞书群**是麻薯的消息入口和运行时通道；**飞书其他服务**（文档、多维表、Wiki、日历等）是与 GitHub 同层的普通连接器，沿用首次飞书连接取得的账户授权，再分别管理资源、读写能力、审计和撤销。页面不能要求用户为这些服务重复连接飞书；未来新增服务应复用同一套连接器合同，而不是继续向 Mochi 增加新的固定产品分栏。

每个连接器都应拥有同一组可见事实：服务与账号、可用资源、能力（read / draft / write 等）、作用域（宿主 / Bot / 当前任务）、授权状态、最近活动、撤销和恢复动作。连接器内部可以使用原生 API、CLI 或 MCP；用户看到的是能力与授权，不是协议名称。

### 现在应该保留

1. 继续保持 Bot 范围的 GitHub 资源选择、飞书群参与、永久 Session 和群话题边界；不要复制 Grok 的账号级连接，也不要因为 Muse 有个人代理而引入跨 Bot 共享资源。
2. 把模型连接保留为宿主共用能力；把连接器做成可扩展集合；把飞书群明确标为消息入口 / 运行时通道。连接成功不能冒充值班就绪，资源授权不能冒充具体写入授权。
3. 连接应该从任务需要进入对应连接器页面：缺 GitHub 项目就打开 GitHub 连接器，缺飞书文档读写能力就打开飞书服务连接器，缺飞书群入口就打开群设置。未来连接器继续进入同一目录和权限模型，不为每个供应商复制一套顶层产品逻辑。
4. 连接页面应同时显示四件事：连接的是哪个账号/身份、实际可用的资源、这个 Bot 或当前任务选择了什么、当前状态与恢复动作。未知、待授权、已连接未选资源、已撤销必须区别显示。
5. Agent 可以判断 Issue 创建/编辑/关闭/分配是否需要询问，以及如何解释依据；代码继续强制 typed mutation、当前话题/项目授权、精确来源消息、幂等审计、远端权威回读和失败关闭。不要恢复旧的“所有高影响操作统一先确认”。

### 未来允许吸收的 UX

- 借 Muse 的“自然语言触发连接”，但触发后必须打开一个确定性的授权卡，明确服务、账号、资源、读写能力和第三方条款；这套卡片应该对 GitHub、飞书 CRUD 和未来连接器通用。
- 借 Grok 的显式当前任务作用域：在飞书回复或 companion 任务详情里显示本次使用的 Bot、项目和工具能力；不要求普通参与者学习 `@` 语法。
- 借 Muse 的“活动/来源/授权”查看面，把已有消息回帖、Issue 回读、反应表情和状态投影组织成一个可追溯详情，而不是新增独立看板或复制对话。
- 若未来支持第三方能力，包元数据应同时声明能力、所需连接、读写范围、Skill/方法文档、版本、审核来源和撤销方式。MCP 可以是实现方式，不能成为用户授权页面本身。连接器目录本身也不能替代真实的 provider、resource 和 capability 回读。

### 不应照搬

- 不照搬 Grok 的所有 Bot 共用浏览器、文件和凭据；这会破坏 Mochi 已确认的分身独立边界。
- 不照搬 Muse 的个人长期目标、主动提醒和后台自动连接；当前 Mochi 的价值是项目全貌、飞书群协作和经授权的外部工作推进，GitHub 是第一个重要证明场景而不是永久唯一连接器。
- 不让“安装成功”“已登录”或“模型说已完成”成为可执行能力的证明；每一层都必须有它自己的真实事实。

## 发行前应补的连接器验收

- GitHub、飞书服务和未来任意连接器都通过同一组 connector/resource/capability 状态验收；GitHub 的“推荐团队上下文”只改变排序和解释，不改变连接器合同。
- 飞书群与飞书服务连接器必须分别验收：群验证事件、成员关系、话题、回帖和运行时状态；服务连接器验证具体文档/表格/Wiki 资源、CRUD 能力、授权和回读。
- 新 Bot 未接入时，任务只提示缺失的具体能力，并能回到对应设置；不引导重新做完整 onboarding。
- OAuth 取消、provider 驳回、组织管理员审批未完成、项目目录为空、群目录未知、连接撤销和模型不可用各有稳定问题码与一个恢复动作。
- 添加新的连接器不应要求修改 Bot / Session / 飞书群的固定领域模型；只需注册 provider、资源目录、能力 schema、授权生命周期和状态投影。
- 同一账号下两个 Bot 的连接、项目、群参与和 Session 互不串线；共用模型连接变化只在全部 Bot 空闲时执行。
- 明确请求的 Issue 写入只询问一次必要信息；模型选择不询问时，代码仍拒绝越权、错误项目、未知来源或未回读成功的写入。
- 断开连接后，新任务不能再调用；已有对话、Issue 审计和 Pi JSONL 不被静默删除；用户能看见“未来访问已停止”与“历史仍保留”的区别。
- 每个工具结果显示来源、资源范围、成功/部分成功/失败和下一步；不以绿色连接徽章替代交付证据。

## 官方依据

- [Grok Bot：Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [Grok Bot：Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [Grok Bot：Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Grok Bot：Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises)
- [Grok：Connectors（通用产品，不能与 Grok Bot 混用）](https://docs.x.ai/grok/connectors)
- [Meta：How Muse works with Connectors](https://www.meta.com/help/artificial-intelligence/1687253048996149/)
- [Meta：How Muse works with your guidance and approval](https://www.meta.com/help/artificial-intelligence/1385290430137537/)
- [Meta：How your Muse agent browses the web](https://www.meta.com/help/artificial-intelligence/2124746764949121/)
- [Meta：How We Designed Muse](https://introducing.muse.ai/)
- [Meta AI Research：How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
- [Meta Newsroom：Introducing Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
