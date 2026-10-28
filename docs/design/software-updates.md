# Mochi 软件更新合同

用户于 2026-10-17 要求系统性落实顺畅的更新体验。首个带完整更新协议的基线为 **0.3.0 / installation schema 6**。本文记录实现的所有权、行为和验收边界；精确候选、公开发布判定继续由 [发行验收](../release-acceptance.md) 独占。

实现包含发现、下载、空闲交接、特权安装、恢复和发布指针。源码测试、原生隔离 fixture 与 WebKit 验证支持这些合同；**真实签名 N → N+1、干净 Mac、系统授权和离线窗口事件交付仍需实机验收**。这些记录不能相互替代，也不授权修改用户日常 App、账号、永久 Session 或正式群。

## 用户看到的流程

设置中的「关于与更新」和系统应用菜单提供同一个检查入口。后台检查与下载默认开启，空闲时自动安装默认关闭。没有更新时不弹窗，不改变用户焦点。下载完成后可选择「空闲时更新」；开启自动安装也必须满足相同门禁。

| 时刻 | 行为 |
| --- | --- |
| 检查 | 启动后及每六小时检查签名 feed；手动检查即时显示结果。固定官方 feed 返回 404 表示尚未发布更新，结果与已是最新相同；离线、服务端错误和验证失败仍如实显示为失败。 |
| 下载 | 显示真实已收字节，支持暂停和同一候选续传；退出重开仍尊重暂停。下载期间伙伴继续工作。 |
| 等待 | 所有已接受的人类请求、队列、安排、整理、登录和最终回帖完成后才取得全局短期许可。可取消等待。 |
| 关闭 | 手动更新复用原生草稿处理；自动更新遇到未保存设置就取消本次安装。确认后还会复查 helper 是否仍在等本 App 退出。 |
| 切换 | 原 App 与全部组件在同一 journal 下切换；本地健康与历史连续性通过前关闭新工作接入。 |
| 完成 | 先持久化 finalized，再开放新工作；重开原来的设置页/选中伙伴，完成通知去重。 |
| 失败 | 保持旧版可用，或明确提供同一事务的恢复入口。已完成提交后的清理失败只前向完成清理，不能回滚新接工作。 |

更新存在有限离线窗口。不得宣称“永不中断”“零丢消息”或未经测量的升级秒数；已接工作和离线期间尚未接下的飞书消息是两种不同的交付边界。

## 单一所有权

| 责任 | 唯一实现 |
| --- | --- |
| 检查、下载、偏好、候选续传、用户安装意图 | `controlApp/src/host/updates.ts`；renderer 只接收闭合状态与动作。 |
| 签名 feed 格式、版本/OS 支持范围、固定分发源 | `src/product/updateFeed.ts`、`release/updates.json`、`release/distribution.json`。 |
| 全局空闲许可、普通控制操作排他、停服确认 | `src/control/updateLifecycle.ts`、现有 Bridge/control socket。 |
| 受信任调用方、私有 staging、原生验证和包执行 | `installer/update.swift`、`installer/update_peer.c`。 |
| App、后台组件、plist、sudoers 的提交、恢复、finalized | 原有 `installer/lifecycle.sh`，仍由内嵌 package 调用。 |
| Session 本地只读检查 | Pi worker protocol 11 的 `session.verify`；不发模型请求、不 bootstrap/fork。 |
| 候选与公开发布资格 | 原有 production、acceptance、publication 链；`script/release_update.ts` 只延伸签名 feed。 |

没有启用 Electrobun 或 Sparkle 的另一套安装器。Sparkle 官方 `sign_update` 仅用于现有 Aha Labs Ed25519 key 的发布签名；Mochi 验证其精确签名字节。这样不需要协调两个 App 替换/回滚 owner。[Sparkle 签名工具说明](https://sparkle-project.org/documentation/)

## 工作交接与历史保留

生命周期协议 1 和普通 control 28 共用私有 socket，版本独立。`acquire` 绑定目标版本与摘要，在同步空闲判断后关闭接入，租期 120 秒；调用方崩溃或超时会释放仍在运行的 Bridge，成功 `stop` 后则不能再次开放。等待最多两小时，到期如实失败。普通配置操作在同一 admission 下计数到异步完成。

App 提交安装期间暂停旧状态投影；提交前已发出的查询及其错误不能结束新一次安装的观察。helper 在回应安装已接受前持久化 `preparing`，避免下一次查询读到上一轮的终态。

空闲不仅指模型 turn 结束：Bot 还持有最终飞书回帖/reaction、已接队列、安排、连接变更、账号动作与事件接收的 admission。新消息在 durable claim 前再次检查更新门禁；安排在领取前检查。更新不改变任何 Bot 的 enabled 选择，不取消已接受的任务，不重放消息或外部写入。

helper 在发送生命周期命令前，以连接的 audit token、签名和固定路径证明旧 Bridge；停服回复仍须匹配该 PID，但不在回复后要求进程继续存活。旧 Bridge 回复停服后，helper 通过 launchd、已知产品进程和 flock 证明旧进程已退出。停止成功才写 root-owned `update-pending`。新 Bridge 在 hold 下创建本地宿主并只读检查绑定历史，延后启动外部连接与安排。旧版已有的本地失败单独保留；新版新增失败不得通过健康门槛，远端暂时断网不作为回滚理由。

Bridge 已停止时，更新与同版修复共用离线交接：确认 launchd 中没有该 job、没有产品进程，验证当前签名 App，并取得持久状态锁后才建立 hold。已加载但不可连接的 Bridge 仍拒绝交接，不能把任意连接错误当作停服证明；App 退出后还会复查原安装用户和 job。

本地连续性摘要覆盖 fleet、Bot 配置/嘱咐、完整 Pi JSONL、Session binding/lineage/初始化候选，以及持久化的群参与、连接器资源/项目选择、安排定义和启停状态。SQLite 按语义行比较，不因 WAL/page 布局变化误判。摘要只存在 root 私有事务请求中，不导出正文、资源身份或凭据。账号和连接仍由原 owner 持有；真实登录保留还需验收，不能只凭文件未删除宣称通过。

普通更新只支持现有 schema 9 和能力 ABI 的兼容版本。ABI/数据格式变化继续走已有显式迁移合同，不能偷偷新建、fork 或换 cwd。尚未首次值班的 Bot 不为更新验收创建对话。

## 特权与统一恢复

首次授权由 Mochi 进程内的 AppKit 边界执行宿主生成的闭合 AppleScript，系统弹窗标明 Mochi；只回传结构化错误编号，取消不算失败。脚本在单独串行队列执行，避免阻塞 UI；不产生 osascript 请求者、不接收 renderer 提供的脚本或路径，内嵌 package 仍是唯一安装权威。[Apple 对线程使用的说明](https://developer.apple.com/forums/thread/759287)要求串行化后台 AppleScript。

首次 App 内标准管理员授权安装 socket 激活的 `app.mochi.update` LaunchDaemon。它按需工作，空闲后退出；实现复用现有受授权 package 注册路径，没有引入第二种服务注册流程。后续更新在原授权仍有效时复用服务。撤销权限、Login Items、标准用户、设备管理和换用户的行为必须实机验证，不能承诺任何 Mac 都永久免授权。

请求只有 `status / install(candidateSha256) / cancel`。没有任意路径、shell、URL、产品或安装包参数。内核 audit token 绑定对端 PID/eUID；Security.framework 证明 Apple Developer ID、固定 Team、Mochi bundle ID 和 `/Applications/Mochi.app/Contents/MacOS/Mochi`。还要核对当前 console 用户与 sudoers 中原安装用户。

helper 只从该用户固定私有 cache 拷贝 regular owned files，复制到 root-owned staging 后重新验 Ed25519、完整 SHA-256/size、版本/OS、App deep signature、Gatekeeper 与内嵌 Installer Team。只读挂载和拷贝后再次验 App。取得 idle lease 后、真正停服前再次从固定 HTTPS 源验证同一未撤回候选和不后退的 feed 身份。

installation schema 6 把 App 与后台加入同一 `transactionalComponents`，新增 daemon plist；全部源验证和准备在停服前完成。组件只通过同卷 rename journal 提交。健康检查失败时恢复匹配的旧 App/组件；恢复失败保留 journal/备份/hold。`finalized` 持久标记在释放 hold 前，之后只能继续清理，不能因清理故障回滚已接工作。

首次准备和同版修复保留仍在运行的 App 目录，避免替换相同 bundle 中断当前界面的资源读取。journal 在开始前比较完整 staged App 与当前 App；不同即拒绝，相同则记录 retained，提交与回滚都不移动它。只有跨版本更新在旧 App 退出后切换宿主 App。

更新结束后的重新打开由 helper 切换到已复验的安装用户与其 GUI bootstrap 域，并以该用户的 HOME、USER、LOGNAME 和最小环境启动 LaunchServices；`launchctl asuser` 本身不会清理 root 的环境。必须回读重新打开的 App 已使用原用户私有目录并可交互，后台健康或 helper 的 completed 不能单独证明这一点。

持久边界包括文件内容与目录项：staging 在停服前落盘，journal 的写前标记、组件 rename 和 native hold/request 使用同一原生 `F_FULLFSYNC` 屏障；失败立即停止，不降级为未确认落盘的成功。package 内的 `mochi-file-sync` 只提供文件系统屏障，不是另一套事务或常驻服务。完成或恢复的 journal 先原子改名为 `Transaction.finalized` / `Transaction.restored`，再递归清理；清理即使先删掉内部标记，路径仍能证明不可再次回滚。多个冲突 journal 保留证据并失败关闭。

同版本修复仍走内嵌 package、同一交接和 journal。修复的成败由发起它的准备动作报告；helper 在状态中标明 `repair`，更新页不把修复的失败或完成显示为更新结果，也不因此跳过启动检查，只承接修复留下的未完成事务并提供「继续恢复」。手动跨版本替换 App 不再是受支持的更新路径。历史 schema 5/0.2.0 开发安装不得静默迁入；需停服备份后明确迁移。ad-hoc 包可用于首次安装/权限 fixture，不能通过要求 Developer ID 的生产更新与同版本 repair 信任门禁。

## 发现、下载与发行

feed 是有界 JSON envelope，Ed25519 验证之后才解析 payload。内容绑定 product、arm64、单调版本、minimumUpdateVersion、最低 macOS、候选 manifest 摘要和不可覆盖的 DMG 路径/字节。发行 notes 是有界纯文本；不加载远端 HTML。已观察的 issuedAt/签名 payload 身份持久化，重开仍拒绝倒退和同时间不同内容。

续传只属于同一候选，校验精确 Range；目标变化先丢弃旧 partial，完成后全量验 hash。网络、头部/分块/总耗时和大小均有边界；空间不足保留旧安装，损坏完整内容不能进入 helper。偏好写入串行化，暂停状态持久化。

`release:update stage/publish/withdraw` 复用原精确候选及验收。publish 先证明所有 immutable downloads 可匿名读回，再用 R2 ETag/If-Match 或 If-None-Match 切换唯一 pointer，并匿名读回。并发写冲突不覆盖，读回未知不当作成功，也不自动“撤销”可能已经提交的写入。withdraw 保留候选身份，只停止未来安装，不对已升级机器做远程降级。具体操作见 [公开发布合同](../public-release.md#signed-update-feed)。

本次实现不切换公共 feed、不上传候选、不建立新签名密钥，也不修改用户日常安装。

## 验证与剩余交付

代码验证包含：真实控制 socket 下的空闲/排他交接、最终回帖的 admission、编译 Pi worker 的同一 JSONL 只读检查、原生 audit-token 正反例、CryptoKit 候选验证、原生连续性摘要与恢复状态、journal 各记录边界中断和整套回退、下载暂停/续传/候选变化、撤回/重放/并发发布、窄屏和键盘 UI。每项真实结果记录在精确提交的验证 receipt 和 PR 中。

schema-8 发行验收保留 `in-app-update` 场景的十四项 checkpoint，默认均 blocked。首个 0.3.0 候选作为发送端 N，与私有 N+1 演练候选验收；两份 manifest 都要记录，不能以“首版无上一版”跳过升级链。所有支持的平台都必须完成：

- 真实签名 N → N+1、最低支持 macOS、管理员/标准用户和权限撤销；
- 繁忙任务/回帖、安排、整理、登录和脏设置，暂停/未连接伙伴；
- 错签名、坏包、低磁盘、断网、休眠、重启、逐边界中断与 finalized 清理；
- 账号、Session 历史/cwd、资源选择、窗口恢复与实际飞书离线窗口交付；
- 实际 VoiceOver/Reduce Motion，并分别量出下载、等待、离线、可交互时长及操作/授权次数。

没有这些实机证据前，可称代码已实现并通过相应测试，不能称公开发行已验收或无感更新已在客户 Mac 兑现。
