import type { ComponentType } from "react";
import { Admin } from "./pages/Admin.tsx";
import { Guide, Privacy } from "./pages/Documents.tsx";
import { Download } from "./pages/Download.tsx";
import { Faq } from "./pages/Faq.tsx";
import { Home } from "./pages/Home.tsx";
import { Insight } from "./pages/Insight.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { Workflow, Workflows, workflows } from "./pages/Workflows.tsx";
import type { PageMetadata } from "./seo.ts";
import { superagentArticle } from "./superagent.ts";

export interface Page extends PageMetadata {
  /** Output file inside the built site. */
  file: string;
  Page: ComponentType;
}

const brand = "Mochi 麻薯";

export const pages: Page[] = [
  {
    ...superagentArticle,
    file: `${superagentArticle.path.slice(1)}index.html`,
    indexed: true,
    Page: Insight,
  },
  {
    path: "/workflows/",
    file: "workflows/index.html",
    name: "实际用法",
    title: `飞书 AI 机器人实际用法：查 GitHub 项目、接 Issue、定时跟进 · ${brand}`,
    description:
      "Mochi 在飞书群里的几种用法：带出处回答 GitHub 项目问题，把确认的讨论接成有负责人的 Issue，按时汇报进展，并用你自己的 ChatGPT 订阅。每篇都说明怎么开始和做不到什么。",
    indexed: true,
    collectionItems: workflows.map((workflow) => ({
      name: workflow.title,
      url: `/workflows/${workflow.slug}/`,
    })),
    Page: Workflows,
  },
  ...workflows.map((workflow) => ({
    path: `/workflows/${workflow.slug}/`,
    file: `workflows/${workflow.slug}/index.html`,
    name: workflow.title,
    title: `${workflow.title} · ${brand}`,
    description: workflow.description,
    indexed: true,
    articleSection: "Mochi 工作流",
    Page: () => <Workflow slug={workflow.slug} />,
  })),
  {
    path: "/",
    file: "index.html",
    name: "首页",
    title: `${brand}：飞书群里懂 GitHub 项目的 AI 同事`,
    description:
      "Mochi 是飞书群里的 AI 项目伙伴：从你们选定的 GitHub 项目查找答案并附上出处，把聊定的事接成有负责人的 Issue，按时汇报进展。用你自己的 ChatGPT，运行在你的 Mac 上。",
    indexed: true,
    Page: Home,
  },
  {
    path: "/download/",
    file: "download/index.html",
    name: "申请内测",
    title: `申请内测 · ${brand}`,
    description:
      "Mochi 正在内测。正式版发布前，Aha Labs 先和少量团队一起使用：准备好一台 Apple 芯片 Mac、ChatGPT 订阅、飞书或 Lark 组织和 GitHub 项目，就可以申请。",
    indexed: true,
    Page: Download,
  },
  {
    path: "/faq/",
    file: "faq/index.html",
    name: "常见问题",
    title: `Mochi 常见问题：数据、权限、设备与模型费用 · ${brand}`,
    description:
      "关于 Mochi 的直接回答：数据存在哪里、会不会改代码、要不要每次 @、支持哪些设备和平台、模型怎么计费、怎么更新和彻底删除。",
    indexed: true,
    Page: Faq,
  },
  {
    path: "/start/",
    file: "start/index.html",
    name: "上手指南",
    title: `Mochi 上手指南：连接飞书与 GitHub 项目 · ${brand}`,
    description:
      "从安装到在飞书群里交代第一件工作：连接 ChatGPT、扫码接入飞书机器人、选择 GitHub 项目，以及安排、记忆、更新与卸载。",
    indexed: true,
    Page: Guide,
  },
  {
    path: "/privacy/",
    file: "privacy/index.html",
    name: "隐私说明",
    title: `隐私说明 · ${brand}`,
    description:
      "Mochi 如何在你的 Mac、模型服务、飞书与 GitHub 之间处理数据：保存什么、发送什么，以及如何停止使用与删除。",
    indexed: true,
    Page: Privacy,
  },
  {
    path: "/admin/",
    file: "admin/index.html",
    name: "给管理员的说明",
    title: `Mochi 权限说明：飞书机器人与 GitHub App · ${brand}`,
    description:
      "写给飞书管理员与 GitHub 组织所有者：Mochi 申请的飞书机器人权限、GitHub App 权限、数据去向与撤销方式。",
    indexed: true,
    Page: Admin,
  },
  {
    path: "/404",
    file: "404.html",
    name: "这一页不存在",
    title: `这一页不存在 · ${brand}`,
    description: "链接可能已经变了。回到首页看看麻薯能做什么。",
    indexed: false,
    Page: NotFound,
  },
];
