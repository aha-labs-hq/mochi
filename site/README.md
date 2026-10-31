# Mochi 官网

静态站点，用 App 同一套 Vite、React 与 Tailwind 构建，预渲染为纯 HTML。首屏舞台、职能演示、一周的群聊、伙伴架与结尾唤醒由 React 增强；禁用 JavaScript 时仍能读完整内容。

```bash
bun run site:build                           # 预览版：发行方信息显示为待确认，页面不被收录
bun run site:build -- --publication <json>   # 真实发行信息，noindex
bun run site:build -- --publication <json> --indexable  # mochi.host：开放搜索收录
bun run site:serve                           # 在 127.0.0.1:4321 查看 site/dist，带上线时的响应头
bun run site:motion                          # App 动效变更后，重新生成网页视频
bun run site:deploy                          # 以真实发行信息部署内测申请站，开放收录
```

## 内容出处

网站不另存这些事实，改动请改出处：

| 内容 | 出处 |
| --- | --- |
| 色板 | `controlApp/src/ui/palette.css` |
| 五个职能对话与示例资料 | `controlApp/src/ui/introductionStories.json` |
| 入场、摸摸、醒来与 Awawa 待机，以及各角色的身体切边 | `motion/manifest.json` 与 `controlApp/src/motion/entrance.ts` |
| 角色、人像与图标 | `controlApp/Resources/`、`controlApp/src/ui/assets/` |
| 页脚的 Aha Labs 笑环 | Aha Labs 品牌源文件（未公开）中的 `svg/aha-labs-ring.svg`，原样复制为 `src/brand/aha-labs-ring.svg`；品牌规定环不小于 40 px |
| 一句话介绍、内测申请表、出品方与设备要求 | `src/facts.ts`；最低 macOS 取自 `src/product/version.ts` |
| 常见问题 | `src/faq.ts`：首页显示 `questions`，`/faq/` 显示全部 `faq` |
| IndexNow 密钥与提交 | `build/indexnow.ts`：可收录构建生成 `/<key>.txt`，每次部署后提交站点地图的全部页面 |
| 上手指南、隐私说明 | `release/public/`，经 `renderPublicDocument` 填入发行方信息 |
| 下载版本、设备、最低系统、使用边界、文件大小与校验值 | 已验收的 `Mochi-Release.json`，经 `validateReleasePublication` 复核 |
| 飞书权限 | `src/lark/permissions.ts` |
| 客户 GitHub App 权限 | `docs/github-governance.md` 的客户 App 合同；`src/pages/Admin.tsx` 用中文说明 |
| 导航、手机菜单与页脚的 GitHub 仓库入口 | `.github/governance.json` 的 `repository.slug` |
| Apple 与 GitHub 品牌图标 | `src/brand/` 中的 Simple Icons SVG，版本与许可见该目录的 `README.md` |

主导航只保留功能、使用指南、常见问题；GitHub 入口与 macOS 下载组成独立的操作区。手机上保留下载，其他入口收进菜单；管理员与隐私资料仍在页脚。所有下载按钮共享 Apple 标识，导航和页面中的下载入口均由 `DownloadAction` 按实际发行阶段显示，不把内测申请伪装成文件下载。

网站自写的对话在 `src/threads.ts`（首屏之外只有“一周”这一条，按滚动分三段追加），只能引用 App 引导已有的示例资料。`src/media/` 的视频由 `site:motion` 从 App 已批准的动效生成，`motion.json` 记录来源与产物摘要；App 动效变更而未重新生成时，测试失败。

## 发布

网站的公开信息由 `site/publication.json` 拥有，与安装包发行流程使用同一 schema。下载页必须是本站 `/download/`。支持入口（`supportUrl`）可以是 HTTPS 页面或 `mailto:` 地址；支持和隐私请求都写邮件到 `hello@mochi.host`。App 的帮助与运行诊断经 `controlApp/src/shared/support.ts` 读取同一个 `supportUrl`，它必须是 `mailto:` 地址；App 不另存地址。Cloudflare Email Routing 将这个地址转发到维护者的 Gmail，按收件人或发件人 `hello@mochi.host` 自动应用 `Mochi` 标签；这不提供 Gmail 的域名发信身份。已验收的公开测试版以下载为入口；没有发行候选的预览保留申请入口，申请表只用于内测申请，地址在 `src/facts.ts`；表单归 Aha Labs 的飞书组织、以用户身份创建，公开填写入口不开放申请记录。网页上线与安装包发行分别验收。

安装包完成签名、公证和 clean-Mac 验收后，在包含该候选源码版本的干净 checkout（候选版本本身或之后的提交）构建下载页；网站因此可以独立于安装包更新，发布文件和随附文档始终来自候选版本：

```bash
bun run site:build -- \
  --publication /absolute/private/publication.json \
  --release-manifest /absolute/candidate/Mochi-Release.json \
  --verification-result /absolute/git-common/mochi-verification/commit/run/result.json \
  --acceptance-record /absolute/evidence/Mochi-Acceptance-clean-arm.json \
  --artifact-base-url https://downloads.your-domain.tld/releases/
```

`--acceptance-record` 可重复指定不同干净目标；必须包含声明的最低 macOS 主版本。所有下载输入必须同时提供；任一记录、源码、校验值或验收项不符，构建在清理 `site/dist` 前失败。没有这些参数时保留内测入口；不会凭发行方信息、`--indexable` 或开发包启用下载。首页、导航、页脚以及下载页的分享与搜索文字随同一状态变化。

版本和文件信息不在网站另设配置。链接由已验收候选的目录名 `Mochi-<version>-<architecture>-<manifest-digest-prefix>/` 和文件名生成，与 `release:stage` 完全一致。安装只链接 DMG，内嵌后台包不成为第二个安装入口。网站仅生成 HTML，不复制大文件或上传产物。

[Cloudflare Pages 每个静态文件上限为 25 MiB](https://developers.cloudflare.com/pages/platform/limits/)，安装映像需要发行方确认的独立存储。上传 `release:stage` 的九个文件，保留上述不可变目录名；HTTPS 下载须无需私有仓库登录。跨来源链接使用普通 `<a>`，存储端为 DMG/PKG 配置 `Content-Disposition: attachment; filename="<原文件名>"`；[浏览器的 `download` 属性不支持跨来源](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a#download)。发布前按 [`docs/public-release.md`](../docs/public-release.md) 完成匿名下载的大小、摘要和响应核对。

`site:deploy` 只部署开放收录的内测申请站。正式下载页只由 `site:deploy:release` 部署：它先匿名回读已上传的发行文件，构建后确认 `/download/` 链接到已发布的 `Mochi.dmg` 才部署；步骤见 [`docs/public-release.md`](../docs/public-release.md#publication-and-readback)。公开测试版用同样的输入经 `site:deploy:public-beta` 部署，候选只需在干净 Mac 上通过安装、安装权限与完整卸载验收，页面与版本说明标明「公开测试版」，门槛见 [`docs/public-release.md`](../docs/public-release.md#public-beta)。获得发布授权后再部署。

`site/wrangler.jsonc` 固定 `mochi-ahalabs` 项目；Pages 配置不接受 `account_id`，由 `site:deploy` 通过 `CLOUDFLARE_ACCOUNT_ID` 固定个人账号。该命令使用发布机上独立的 `~/.config/aha-labs/.wrangler/` 登录，部署到生产分支 `main`。正式地址是项目的自定义域名 <https://mochi.host/>；`mochi-ahalabs.pages.dev` 仍可访问，页面的 canonical 与分享地址都指向 mochi.host。

## 响应头

`build/headers.ts` 生成 Pages 的 `_headers`：带哈希的静态资源长期缓存；所有响应带 HSTS（一年，含子域名）和内容安全策略；`*.pages.dev` 地址另加 `X-Robots-Tag: noindex`，只有 mochi.host 被收录。内容安全策略允许本站资源、Cloudflare Web Analytics 的脚本与上报端点，内联脚本只允许页面里的 sha256，构建时从生成的页面算出；React 写在元素上的样式需要 `style-src 'unsafe-inline'`。引入外站的脚本、样式、字体、图片或视频，要先改这个文件，否则浏览器会拦下。`site:serve` 按同一个 `_headers` 加响应头，部署前在本地打开每一页，控制台不应有任何内容安全策略报错。

发布前保存一个干净的提交，运行 `bun run verify` 并保留该提交的通过证据。发布后检查首页、所有子页、真实 404、申请入口、`robots.txt`、`sitemap.xml`、静态资源的 HTTP 响应和响应头（mochi.host 带 CSP 与 HSTS、不带 noindex；pages.dev 带 noindex），并在浏览器核对桌面与窄屏交互。

## Google 搜索

观点文章位于 `/insights/deepseek-superagent-team-context/`，正文与公开元数据由 `src/superagent.ts` 维护，`src/pages/Insight.tsx` 复用现有阅读版式。页脚和实际用法目录提供入口；页面显示 Aha Labs 署名、真实发布日期与来源链接，日期同步到 Article 与 Open Graph。新增文章路由经同一 `pages` 清单生成静态 HTML、canonical 和站点地图，不把研究原型描述为已发布的完整产品，也不暗示 Mochi 与 DeepSeek 存在隶属关系。

所有构建生成完整 HTML、每页唯一标题和描述、分享卡片与图标。分享卡 `og.png` 由 `build/site.ts` 画出：麻薯趴在写着产品名和一句话介绍的卡片上，字体用 macOS 自带的苹方，所以要在 Mac 上构建。正式域名是 mochi.host，2026-10-14 起开放收录：`site:deploy` 以 `--indexable` 构建。不带该参数的构建（预览与本地检查）保持 noindex、不生成站点地图；robots 始终允许抓取，以便搜索引擎读到页面的 noindex。

`--indexable` 生成绝对 canonical、WebSite / Organization / SoftwareApplication / BreadcrumbList 结构化数据和站点地图。每个可索引页面都带完整的出品方、站点与 Mochi 实体图，Organization 指向出品方自己的网站 ahalabs.site，Mochi 使用稳定的产品 ID 并连接官网与案例；工作流页标为 Article，目录页标为 CollectionPage / ItemList。`robots.txt` 明确允许 `OAI-SearchBot`，声明搜索与实时回答可用但不授权训练，robots 与 sitemap 都要求重新验证，404 始终保持 noindex；不添加 `llms.txt` 或 AI 专用页面。

没有已确认的价格、评分或页面修改日期时，不编造这些数据。常见问题在页面保留；[Google 已退役 FAQ 富结果](https://developers.google.com/search/updates)，不再为它添加专用标记。

Search Console 使用已有的 `sc-domain:mochi.host` 域名资源；保留真实 DNS 验证记录，提交并检查 `/sitemap.xml`。资源可访问不等于每个页面已收录。[Google 验证说明](https://support.google.com/webmasters/answer/9008080)。

线上性能用 PageSpeed Insights 测量。实验室评分、Google 实际收录和真实访问者的 Core Web Vitals 分开报告；新站暂无真实访问数据时不宣称已有优秀的现场指标。

## 网站访问统计

`public/analytics.js` 统一加载统计脚本，站长与其他访客使用同一口径。不再保存或读取浏览器排除偏好，也没有统计设置页。正式域名、非自动化、可收录页面才统计；`/privacy/` 保留原有产品政策，不增加统计说明或入口。旧统计网址直接回首页。

`build/headers.ts` 的 `Cache-Control: no-transform` 阻止 Cloudflare 自动插入第二份 beacon，区域原有开关可保持启用；带哈希的资源仍长期缓存，HTML 和统计脚本重新验证。不借网站统计改动发布新的应用版本或其他尚未批准的网站内容。

### Cookie-free daily visitors

[Ahrefs Web Analytics](https://app.ahrefs.com/web-analytics/10576409) is the
primary visitor report. The personal account uses the Free plan: up to one
million events per project per month, with no paid add-on. Ownership is verified
by the domain's Ahrefs TXT record in the personal Cloudflare account. The public
collection key belongs to this project and is owned by `public/analytics.js`.

Normal visitors, including the site owner, load Ahrefs and Cloudflare without
analytics cookies, a popup or a consent click. There is no self-exclusion flag,
settings page or browser-storage dependency. Previously stored exclusion values
are ignored. Automated browsers, preview hosts and noindex pages remain unmeasured.

Ahrefs uses a daily salted IP and browser-type hash, discarding raw IPs from
its analytics database and logs. Daily visitors are estimates, not identifiable
people: another day, browser, device or network can count again; shared network
and browser signatures can merge. Do not label a multi-day sum as deduplicated
people, or add Ahrefs and Cloudflare totals. Cities reflect the network exit,
not GPS. Reports include sources, UTM campaigns, devices, pages and trends.

The loader supplies a sanitized page URL with only the six bounded standard
UTM parameters; email-like values and fragments are removed. The site's strict
origin referrer policy limits referrer disclosure. Ahrefs also observes public
link destinations and form action URLs, never field values. Contact forms use
POST/JSON or prevent default submission; keep personal data out of URLs and
link targets. No account ID, canvas, chat or form body is supplied to analytics.
Ahrefs may use anonymous aggregate data for research and service improvements.

Google Analytics no longer loads. Historical Google properties are retained,
not used for current traffic. Functional cookies are unaffected. New daily-visitor
data starts at deployment; no historical Cloudflare visits are converted into people.

Mochi production remains an overlay on the existing approved website artifact.
The added website-statistics copy is removed from the existing product privacy
page, and retired analytics URLs return to the homepage. The overlay carries
the current loader entry as `analytics.js?v=4`, which records only fixed
navigation intents and never form values. Do not publish unrelated current
website or application changes with this update.

The analytics entry uses `?v=4` to bypass browser copies of the old consent
loader cached for four hours by Cloudflare's default Browser Cache TTL. Its
response uses `no-cache, no-transform`. The Cloudflare zone's Browser Cache TTL
must be **Respect Existing Headers**: its four-hour override also stripped
`no-cache` from responses. A CDN purge cannot invalidate a visitor's already-cached
file. Verify the live response headers and returning profiles as well as clean ones.

## 实际用法与申请验收

`src/pages/Workflows.tsx` 拥有具体工作流与目录页：飞书 AI 机器人的整体用法、
从项目问题得到可核对的依据、把已确认的讨论接成有负责人的 Issue、定时汇报与跟进，
以及在飞书里使用自己的 ChatGPT。先说明人的
卡点和拿到的成果，再解释飞书、GitHub 与操作。示例不是客户记录，
不编造节省时间、采用人数或效果保证。网页发布不改变应用发行状态。

统计入口更新为 `analytics.js?v=4`。`get_started_open` 只代表点向
本站申请/下载页，`beta_form_open` 只代表打开标记过的内测申请入口；
这两个事件必须在 Ahrefs 的 Tracked events 中登记，不等于表单提交。
真正的申请、合适的团队和开始使用，分别以收到的表单、交流与实际
使用证据确认。委托点击监听兼容既有页面的 React 增强；只传固定事件名，
不读取输入内容、邮箱或群聊，不增加浏览器存储和第三方统计服务。

本次发布用 `build/growth-overlay.ts` 在已批准的生产产物上叠加页面。
先逐字节回读五个现有线上 HTML，证明基线未变，再运行：

```sh
bun run site:build -- --publication site/publication.json --indexable
bun site/build/growth-overlay.ts <已批准产物> site/dist <新产物目录>
```

脚本保留全部既有资源，仅增加三页工作流及其静态依赖，给既有页脚
加入口，更新统计加载版本，并说明上手文档从收到内测包开始。
新阅读页只使用 HTML/CSS，不带当前应用衍生的客户端脚本。脚本拒绝
覆盖输出、改变已有同名哈希资源或接受结构已变化的基线，并在输出
旁保存逐文件 SHA-256 清单。部署前检查清单、全部内部链接、CSP、
桌面/窄屏与当前申请表；保留原产物供网站回滚。后续经过独立授权的
完整网站发行可恢复正常构建路径，不借此发布未验收安装包。

## 页面设计与验收

页面沿用 App 的中性纸面、蓝色、系统中文字体与已审核角色素材。内容层级由留白、字号和少量底色建立，不用装饰性分割线；权限表格保留必要行结构。首页从可直接阅读的群聊示例进入职能场景，再讲持续协作、安全边界与上手。删除了模拟提速对比和重复的痛点铺陈，旧章节锚点仍可定位。

首屏对话随 HTML 直接可读，不等待角色动画或客户端加载。角色仍使用原 motion manifest 的几何与动作；减少动态效果时直接显示静态形象。职能页保留 App 同源的五个故事，方向键和 Home/End 可切换，来源用原生模态框查看。所有页面都要检查 320 px 窄屏、桌面、文字放大、键盘、减少动态效果与禁用 JavaScript；不把源码检查当成视觉验收。

管理员页描述客户 Mochi Companion 的七项仓库权限，不能引用私有 Mochi Maintainer 的治理清单。客户代码与 PR 只读，Issue 读写；两种 App 的身份与权限拆分见 `docs/github-governance.md`。
