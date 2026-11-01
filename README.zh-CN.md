# Mochi 麻薯

**项目的来龙去脉，群里就能问明白。**

Mochi 是运行在 Mac 上的项目伙伴，适合在飞书或 Lark 里讨论、用 GitHub 保存项目知识的团队。
哪里改了、当时为什么这么定、现在还卡在哪——麻薯去你选定的项目里查，把依据带回原来的讨论。

[下载 Mac 测试版](https://mochi.host/download/?utm_source=github&utm_medium=readme&utm_campaign=public-launch) ·
[看看它怎么工作](https://mochi.host/?utm_source=github&utm_medium=readme&utm_campaign=public-launch#roles) ·
[English](README.md)

[![官网示例：运营询问功能是否已经可用，麻薯给出答案，并附上发布记录和原决定的链接](docs/assets/github/mochi-workflow.jpg)](https://mochi.host/?utm_source=github&utm_medium=readme&utm_campaign=public-launch#roles)

*这是官网的示例对话，不是客户聊天记录。当前 App 界面与官网使用简体中文。*

## 同一件事，从问清楚到接着做

- **答案有出处。** 查代码、Issue 和 PR，把判断和依据一起带回来；你可以点开来源核对。
- **决定有人接。** 明确交代后，创建或更新 Issue，写上负责人，保留原讨论的链接。代码和 PR 只读。
- **后续接得上。** 过几天再问同一件事，继续查进展和阻塞，不用从头解释背景。

例如，发客户邀请之前，可以这样问：

> @麻薯，现在能说“公开链接不用登录就能看”了吗？查一下实现和相关 Issue，把依据列出来。

团队定下范围后，再说：

> 把刚才确定的范围更新到原 Issue，派给 Evan。

这是使用方法示例。实际使用时换成你们的项目、事项和真实负责人，以上文案不代表某个功能已经上线。

## 从一个项目、一个问题开始

1. [下载公开测试版](https://mochi.host/download/?utm_source=github&utm_medium=readme&utm_campaign=public-launch)，
   拖进「应用程序」。首次准备后台组件需要一次 Mac 管理员授权。
2. 连接自己的 ChatGPT 订阅或兼容 Responses API 的模型服务，用飞书或 Lark 扫码，
   授权并选好 GitHub 项目。
3. 把机器人加进群，在 Mochi 里开始值班，@ 它问一个你们项目里的真实问题。
   看完回答，再点开它给的依据。

需要 **Apple 芯片 Mac、macOS 14 或更新版本**，以及飞书或 Lark 组织和有项目访问权限的 GitHub 账号。
组织可能要求管理员审批。整个使用接入过程在 Mochi 和官方授权页中完成，不用打开终端。

[完整上手指南](https://mochi.host/start/) ·
[给管理员的说明](https://mochi.host/admin/) ·
[常见问题](https://mochi.host/faq/)

## 开始前，把边界讲清楚

- **用你自己的账号。** Mochi 在 Mac 上运行，需要的上下文会发给你选择的模型服务，额度和费用由该服务决定。
- **只读你选的项目。** GitHub 项目由你明确选择。有人授权交代时才写入 Issue，不修改代码、不合并 PR。
- **同一位伙伴参与的群共享记忆。** 不同伙伴的记忆和项目权限彼此独立；可以关闭某个群的回应。
- **Mac 要在线。** Mac 和机器人需要保持运行、联网，它不是无需设备在线的托管服务。

接入工作资料前，请阅读[隐私说明](https://mochi.host/privacy/)。
当前版本、安装要求和已知限制以[下载页](https://mochi.host/download/)为准。

## 一起把 Mochi 做好

先试一个真实问题，再告诉我们回答或接入过程哪里不顺。
[提交反馈](https://github.com/aha-labs-hq/mochi/issues)时，写上版本、预期和实际结果；
不要公开私人聊天、凭据或项目资料。如果这个方向对你有用，也欢迎 Star。

欢迎代码贡献，先读 [CONTRIBUTING.md](CONTRIBUTING.md)；漏洞请按[安全政策](SECURITY.md)私下报告。
代码采用 [Apache-2.0](LICENSE)，见 [NOTICE](NOTICE)；名称、角色与美术素材遵循单独的[使用条款](TRADEMARKS.md)。

[架构](docs/product-architecture.md) · [开发与验证](docs/github-governance.md#verification) ·
[工程参考](README.md#for-developers)
