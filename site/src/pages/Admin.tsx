import type { ReactNode } from "react";
import { FEISHU_REQUESTABLE_SCOPES } from "../../../src/lark/permissions.ts";
import { PENDING, supportText, useSite } from "../context.ts";
import { Shell } from "../layout.tsx";
import { cn } from "../ui.tsx";

/* Plain words for every Feishu permission Mochi requests. The scope list
   itself belongs to the Bridge; a scope without words here fails the build. */
const feishuWords: Record<string, string> = {
  "im:message.group_msg": "接收它所在群里的消息，用来理解当前讨论",
  "im:message:readonly": "读取消息正文，以及消息引用的上文",
  "im:message:send_as_bot": "以机器人身份在群里或话题中回复",
  "im:message.reactions:write_only": "用表情回应，表示“收到了，正在处理”",
  "im:chat:read": "确认机器人加入了哪些群",
  "docx:document:readonly": "读取消息里引用的飞书文档",
  "wiki:node:read": "读取消息里引用的知识库页面",
  "drive:drive.metadata:readonly": "读取所引用文档的标题和类型",
  "application:application:self_manage": "核对机器人应用已经发布、配置正确",
};
for (const scope of FEISHU_REQUESTABLE_SCOPES)
  if (!feishuWords[scope])
    throw new Error(`No plain words for Feishu scope ${scope}`);

/* GitHub shows the App's registered permissions on its installation page. */
const githubWords: Record<string, [string, string]> = {
  metadata: ["读", "仓库名称、所属组织等基本信息"],
  contents: ["读", "读取代码、提交和发布记录；只读"],
  issues: ["读写", "读取 Issue；有人明确交代时创建、修改、指派或评论"],
  pull_requests: ["读", "读取 PR 和评审；只读"],
  checks: ["读", "读取检查结果"],
  statuses: ["读", "读取提交状态"],
  actions: ["读", "读取 Actions 的运行情况"],
};
// The customer App is independent of the private repository-maintenance App.
const githubPermissions = Object.keys(githubWords);

function Part({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="site-grid gap-y-6 py-10 md:py-14">
      <h2 className="col-span-4 text-title font-semibold md:col-span-4">
        {title}
      </h2>
      <div className="col-span-4 text-[16px] leading-[30px] md:col-span-8">
        {children}
      </div>
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0">
      <table className="w-full min-w-[520px] border-collapse text-left text-[15px] leading-[25px]">
        <thead>
          <tr className="border-b border-hairline text-caption text-muted">
            {head.map((cell) => (
              <th key={cell} scope="col" className="py-3 pr-6 font-normal">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are fixed for the page.
            <tr key={index} className="border-b border-hairline align-top">
              {row.map((cell, column) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are fixed for the page.
                  key={column}
                  className={cn(
                    "py-3.5 pr-6",
                    column === 0 && "whitespace-nowrap",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const code = (text: string) => (
  <code className="rounded-md bg-note px-1.5 py-0.5 font-mono text-[13px]">
    {text}
  </code>
);

export function Admin() {
  const { publication } = useSite();
  return (
    <Shell>
      <div className="site-container py-16 md:py-24">
        <header className="max-w-[760px] pb-12 md:pb-16">
          <p className="mb-5 text-small text-muted">
            写给飞书管理员与 GitHub 组织所有者
          </p>
          <h1 className="phrase section-title">给管理员的说明</h1>
          <p className="mt-6 text-lead text-muted">
            团队里有人想把麻薯请进飞书群，需要你批准。这一页说明它会申请哪些权限、数据去哪里、怎么撤销，读完就能判断。
          </p>
        </header>

        <Part title="它是什么">
          <p>
            Mochi 是一个 macOS 应用，运行在团队成员自己的 Mac
            上。它把一个飞书机器人放进团队选定的群里：大家在群里 @
            它，它读取团队明确选定的 GitHub 项目回答问题，并在有人明确交代时更新
            Issue。思考使用团队自己的 ChatGPT 订阅或模型 API。
          </p>
        </Part>

        <Part title="飞书机器人权限">
          <p className="mb-6">
            机器人以应用身份申请以下权限。组织要求审批时，需要你在飞书管理后台批准。
          </p>
          <Table
            head={["权限", "用途"]}
            rows={FEISHU_REQUESTABLE_SCOPES.map((scope) => [
              code(scope),
              feishuWords[scope],
            ])}
          />
          <p className="mt-6 text-muted">
            共享邮箱是可选能力：只有成员在 Mochi
            中另行授权并选定邮箱后，才以该成员的身份只读访问选定的公共邮箱，不能发送、回复、删除或移动邮件。
          </p>
        </Part>

        <Part id="github" title="GitHub 权限">
          <p className="mb-6">
            Mochi 通过 GitHub App「Mochi Companion」访问项目。安装时，GitHub
            会列出这个 App 注册的全部权限：
          </p>
          <Table
            head={["权限", "访问级别", "用途"]}
            rows={githubPermissions.map((permission) => [
              code(permission),
              githubWords[permission]![0],
              githubWords[permission]![1],
            ])}
          />
          <ul className="mt-6 list-disc space-y-2 pl-5 marker:text-muted">
            <li>Mochi 产品只读代码和 PR，唯一会写的是 Issue。</li>
            <li>
              客户使用的 Mochi Companion 与维护 Mochi 自身源码的私有 App
              完全分开。Mochi Companion 不申请代码和 PR 写入权限。签发 Issue
              临时令牌的私钥由授权服务持有，不在成员的 Mac 上。
            </li>
            <li>
              安装时可以只选择允许访问的仓库；成员还要在 Mochi
              里逐个打开项目，未打开的项目麻薯看不到。
            </li>
            <li>
              读取时，Mochi 用成员的 GitHub
              登录换取只对单个所选仓库有效的只读令牌。登录令牌保存在成员的 Mac
              上，只用来确认身份、列出项目、换取只读令牌，以及修改 Issue
              时向授权服务证明发起人；它本身不用来写入。
            </li>
            <li>
              修改 Issue 时，请求先经过 Mochi
              的授权服务，核对发起人、仓库和写入权限后，签发只能操作 Issue
              的临时令牌。令牌用完即弃，不保存。
            </li>
          </ul>
        </Part>

        <Part title="数据去向">
          <ul className="list-disc space-y-3 pl-5 marker:text-muted">
            <li>
              <strong className="font-semibold">成员的 Mac</strong>
              ：保存连接、访问范围、嘱咐、工作记录和安排。运行日志留在本机，不自动上传。
            </li>
            <li>
              <strong className="font-semibold">所选的模型服务</strong>
              ：用 ChatGPT 时是 OpenAI，用模型 API
              时是成员填写的服务地址。它收到完成任务所需的消息、上下文、图片和读取到的项目资料，保留规则由该服务决定。
            </li>
            <li>
              <strong className="font-semibold">飞书</strong>
              ：读取获准群的消息与资料，在群里回复。
            </li>
            <li>
              <strong className="font-semibold">
                GitHub 与 Mochi 授权服务
              </strong>
              ：只访问选定项目。授权服务运行在 Cloudflare
              上，处理当次写入所需的令牌、账号与项目标识和拟写入的 Issue
              内容，不接收完整聊天历史；它的日志不含令牌和正文，最多保留 7 天。
            </li>
            <li>
              <strong className="font-semibold">公开网页</strong>
              ：做公开研究时，搜索语句和网址会发给对应的搜索服务和网站。
            </li>
          </ul>
          <p className="mt-6">
            完整说明见
            <a href="/privacy/" className="text-primary hover:underline">
              隐私说明
            </a>
            。
          </p>
        </Part>

        <Part title="撤销与卸载">
          <ul className="list-disc space-y-3 pl-5 marker:text-muted">
            <li>
              成员可以在 Mochi
              里暂停伙伴、关闭某个群、取消项目或邮箱，或断开连接。
            </li>
            <li>
              彻底撤销服务端授权，需要在对应平台操作：在飞书管理后台停用应用，在
              GitHub 的组织或账号设置中卸载 Mochi
              Companion。本机断开不等于远端授权已撤销。
            </li>
            <li>
              卸载有两种：保留数据，或删除本机全部数据。已经发到群里的回复、写进
              GitHub 的内容，以及模型服务保留的请求，不会因卸载而删除。
            </li>
          </ul>
        </Part>

        <Part title="联系">
          <p>
            使用问题：
            {publication ? (
              <a
                href={publication.supportUrl}
                className="text-primary hover:underline"
              >
                {supportText(publication.supportUrl)}
              </a>
            ) : (
              <span className="text-muted">{PENDING}</span>
            )}
            <br />
            隐私请求：
            {publication ? (
              <a
                href={`mailto:${publication.privacyContactEmail}`}
                className="text-primary hover:underline"
              >
                {publication.privacyContactEmail}
              </a>
            ) : (
              <span className="text-muted">{PENDING}</span>
            )}
          </p>
        </Part>
      </div>
    </Shell>
  );
}
