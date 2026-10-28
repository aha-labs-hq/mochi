import type { ReactNode } from "react";
import type { Picture as PictureData } from "../../build/pictures.ts";
import { useSite } from "../context.ts";
import { needs, releaseName, tagline } from "../facts.ts";
import { questions } from "../faq.ts";
import { Island } from "../islands/index.tsx";
import { Shell } from "../layout.tsx";
import { art } from "../media.ts";
import { cast, entranceStage } from "../motion.ts";
import {
  cn,
  DownloadAction,
  Phrases,
  Picture,
  Route,
  Section,
} from "../ui.tsx";

/** A section title; `|` marks where its Chinese may break. */
function Display({
  id,
  text,
  className,
}: {
  id: string;
  text: string;
  className?: string;
}) {
  return (
    <h2 id={id} className={cn("section-title", className)}>
      <Phrases text={text} />
    </h2>
  );
}

function Hero() {
  const { release } = useSite();
  return (
    <section aria-labelledby="hero-title" className="home-hero">
      <div className="site-container hero-layout">
        <div className="hero-copy">
          <p className="mb-6 text-small font-medium text-primary">
            麻薯，{tagline}
          </p>
          <h1 id="hero-title" className="hero-title">
            <Phrases text="项目的来龙去脉，|群里就能问明白。" />
          </h1>
          <p className="hero-description">
            从你们选定的 GitHub
            项目里找依据，接住群里的问题、决定和后续进展。你照常说话，它把事情串起来。
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2">
            <DownloadAction />
            <Route href="#roles" glyph="arrowDown">
              看看它怎么工作
            </Route>
          </div>
          <p className="mt-5 text-caption text-muted">
            {release ? releaseName(release) : "内测中"}，在你的 Mac 上运行
          </p>
        </div>
        <div className="hero-example">
          <Island.HeroStage stage={entranceStage} />
          <p className="mt-5 text-center text-caption text-muted">
            答案有出处，点开蓝色链接就能看。
          </p>
        </div>
      </div>
    </section>
  );
}

function Meet() {
  const verbs = [
    ["问得到", "问进展、问原因、问“当时怎么定的”，答案都附出处。"],
    ["接得住", "聊定的事说一声，它就写进 Issue，带上负责人和原讨论的链接。"],
    ["跟得上", "随时追问进展；也能约好时间，到点把结果发回群里。"],
  ] as const;
  return (
    <Section id="meet" labelledBy="meet-title" className="context-section">
      <span id="taxes" />
      <span id="divide" />
      <div className="site-grid items-center gap-y-14">
        <div className="col-span-4 md:col-span-8 md:col-start-3 lg:order-2 lg:col-span-6 lg:col-start-7">
          <Picture
            picture={art.folio}
            alt="一本打开的毛毡项目册：左页是讨论和确认，右页是代码和工作看板"
            sizes="(min-width: 1024px) 560px, 90vw"
            className="mx-auto h-auto w-full max-w-[500px]"
          />
        </div>
        <div className="col-span-4 md:col-span-10 lg:order-1 lg:col-span-5">
          <Display id="meet-title" text="讨论在群里，|依据在项目里。" />
          <p className="mt-7 text-lead text-muted">
            Mochi
            把两边连起来。你关心客户能不能用、需求为什么搁置、发布还差什么；麻薯去查代码、Issue
            和 PR，把依据带回同一场讨论。
          </p>
          <dl className="mt-9 space-y-5">
            {verbs.map(([verb, words]) => (
              <div
                key={verb}
                className="grid grid-cols-[88px_minmax(0,1fr)] gap-4"
              >
                <dt className="text-[17px] leading-7 font-semibold">{verb}</dt>
                <dd className="text-muted">{words}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Section>
  );
}

function Roles() {
  return (
    <Section id="roles" labelledBy="roles-title">
      <Display id="roles-title" text="站在你的角度，|一起把事往前推。" />
      <p className="mt-5 mb-12 text-lead text-muted md:mb-16">
        选一个职能，从一段具体的讨论开始。
      </p>
      <Island.RoleStories initial="lead" />
      <div className="mt-8 flex flex-wrap items-center justify-end gap-x-5 gap-y-3">
        <Route href="/workflows/">更多实际用法</Route>
      </div>
    </Section>
  );
}

function Week() {
  return (
    <Section id="week" labelledBy="week-title">
      <Display id="week-title" text="同一件事，|从聊定到上线" />
      <p className="mt-5 max-w-[30em] text-lead text-muted">
        一次讨论留下的决定，下一次追问还能接得上。
      </p>
      <div className="mt-8 lg:mt-0">
        <Island.StoryScroll />
      </div>
    </Section>
  );
}

const promises: { icon: PictureData; title: string; words: ReactNode }[] = [
  {
    icon: art.icons.general,
    title: "在你的 Mac 上运行",
    words:
      "工作记录、连接和设置都存在你的电脑上。回答问题时，需要的内容会发给你选的模型。",
  },
  {
    icon: art.icons.model,
    title: "用你自己的模型",
    words: "ChatGPT 订阅或你选的模型 API，额度和计费都在你自己的账号里。",
  },
  {
    icon: art.icons.projects,
    title: "只看你选的",
    words:
      "GitHub 项目和共享邮箱由你明确选择。新加入的飞书群默认回应，你可以随时关闭。",
  },
  {
    icon: art.icons.issue,
    title: "代码和 PR 只读",
    words: (
      <>
        代码和 PR 的授权都是只读。有人明确交代时，才会创建或修改 Issue。
        <a
          href="/admin/#github"
          className="text-primary underline underline-offset-4"
        >
          查看完整权限
        </a>
        。
      </>
    ),
  },
  {
    icon: art.icons.groups,
    title: "记忆边界先讲清",
    words:
      "同一位伙伴参与的群共享记忆，开始之前就会告诉你；不同伙伴之间互不相通。",
  },
  {
    icon: art.icons.connectors,
    title: "随时收手",
    words: "暂停、断开、关掉某个群都可以；卸载时可以选择保留数据或全部删除。",
  },
];

function Trust() {
  return (
    <Section id="trust" labelledBy="trust-title">
      <div className="site-grid gap-y-6">
        <Display
          id="trust-title"
          text="放心把它请进群"
          className="col-span-4 md:col-span-8 lg:col-span-6"
        />
        <p className="col-span-4 text-lead text-muted md:col-span-10 lg:col-span-5 lg:col-start-8 lg:self-end">
          它能做什么、不能做什么，在你请它进群之前就写清楚。
        </p>
      </div>
      <ul className="trust-grid">
        {promises.map((item) => (
          <li
            key={item.title}
            className="grid grid-cols-[48px_minmax(0,1fr)] items-start gap-x-5"
          >
            <span className="row-span-2">
              <Picture
                picture={item.icon}
                alt=""
                sizes="56px"
                className="size-12"
              />
            </span>
            <h3 className="text-[1.0625rem] leading-7 font-semibold">
              {item.title}
            </h3>
            <p className="mt-2 text-small text-muted">{item.words}</p>
          </li>
        ))}
      </ul>
      <div className="mt-12 flex flex-col gap-5 rounded-card bg-note p-6 md:flex-row md:items-center md:justify-between md:p-8">
        <div>
          <p className="text-[17px] leading-7 font-semibold">
            需要飞书管理员或 GitHub 组织所有者批准？
          </p>
          <p className="mt-1 text-muted">
            把这一页发给他们：权限、数据去向和撤销方式，一页说清。
          </p>
        </div>
        <Route
          href="/admin/"
          className="shrink-0 rounded-xl bg-note px-5 hover:text-ink"
        >
          给管理员的说明
        </Route>
      </div>
    </Section>
  );
}

function Companions() {
  return (
    <Section id="companions" labelledBy="companions-title">
      <div className="site-grid items-end gap-y-14">
        <div className="col-span-4 md:col-span-10 lg:col-span-5">
          <Display id="companions-title" text="一台 Mac，|可以请好几位伙伴" />
          <p className="mt-7 text-lead text-muted">
            给产品群请一位，给客服邮箱请一位。每位有自己的名字、形象、嘱咐和记忆，连接的项目和群也各管各的。
          </p>
          <p className="mt-6 text-small text-muted">
            形象只是外观，不改变它能做什么。摸摸看：麻薯和 Awawa 会回应你，Kiwi
            还在学。
          </p>
        </div>
        <div className="col-span-4 md:col-span-10 lg:col-span-7 lg:col-start-6">
          <Island.Cast shelf={cast} />
        </div>
      </div>
    </Section>
  );
}

function Start() {
  const { release } = useSite();
  const steps = [
    [
      "安装",
      "把 Mochi 拖进“应用程序”，按提示准备后台组件，需要一次 Mac 管理员授权。",
    ],
    [
      "连接",
      "登录 ChatGPT，用飞书扫码，选好 GitHub 项目。全部在 Mochi 和官方授权页里完成，不用打开终端。",
    ],
    ["在群里 @麻薯", "问它一个你们项目里的真实问题。"],
  ] as const;
  return (
    <Section id="start" labelledBy="start-title">
      <Display id="start-title" text="从你们正在做的事开始。" />
      <div className="site-grid mt-14 gap-y-12 md:mt-20">
        <div className="col-span-4 md:col-span-10 lg:col-span-4">
          <div className="rounded-card bg-note p-6 md:p-7">
            <p className="text-[17px] leading-7 font-semibold">
              开始之前，准备好
            </p>
            <ul className="mt-4 space-y-3 text-[15px] leading-[25px]">
              {needs(release).map((need) => (
                <li key={need} className="flex gap-3">
                  <span
                    className="mt-[10px] size-1 shrink-0 rounded-full bg-muted"
                    aria-hidden
                  />
                  {need}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <ol className="col-span-4 space-y-7 md:col-span-12 lg:col-span-7 lg:col-start-6">
          {steps.map(([title, words], index) => (
            <li
              key={title}
              className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-5"
            >
              <p className="row-span-2 flex size-10 items-center justify-center rounded-full bg-note font-brand text-small font-medium text-muted">
                {index + 1}
              </p>
              <h3 className="text-[1.0625rem] leading-7 font-semibold">
                {title}
              </h3>
              <p className="col-start-2 mt-1 max-w-[32em] text-muted">
                {words}
              </p>
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-3">
        <DownloadAction />
        <Route href="/start/">查看完整上手指南</Route>
      </div>
    </Section>
  );
}

function Questions() {
  return (
    <Section id="faq" labelledBy="faq-title">
      <div className="site-grid gap-y-10">
        <div className="col-span-4 md:col-span-10 lg:col-span-4">
          <Display id="faq-title" text="还有顾虑？" />
          <p className="mt-6 text-muted">
            更多细节见
            <a
              href="/faq/"
              className="text-primary underline underline-offset-4"
            >
              全部常见问题
            </a>
            、
            <a
              href="/privacy/"
              className="text-primary underline underline-offset-4"
            >
              隐私说明
            </a>
            和
            <a
              href="/admin/"
              className="text-primary underline underline-offset-4"
            >
              给管理员的说明
            </a>
            。
          </p>
        </div>
        <div className="col-span-4 space-y-2 md:col-span-12 lg:col-span-7 lg:col-start-6">
          {questions.map(([question, answer]) => (
            <details
              key={question}
              className="group rounded-2xl bg-card px-5 open:bg-note md:px-6"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[17px] leading-7 font-medium [&::-webkit-details-marker]:hidden">
                {question}
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-[rotate,color] duration-200 group-open:rotate-45 group-hover:text-ink motion-reduce:transition-none">
                  <svg
                    viewBox="0 0 20 20"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    aria-hidden
                  >
                    <path d="M10 4.25v11.5M4.25 10h11.5" />
                  </svg>
                </span>
              </summary>
              <p className="-mt-1 max-w-[38em] pb-6 text-muted">{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Closing() {
  return (
    <section
      aria-labelledby="closing-title"
      className="closing-section pt-20 md:pt-24"
    >
      <div className="site-container text-center">
        <h2
          id="closing-title"
          className="mx-auto max-w-[16em] text-[30px] leading-[42px] font-semibold tracking-[-0.015em] md:text-[44px] md:leading-[60px]"
        >
          <Phrases text="下一次有人在群里问|「这个谁知道？」|让麻薯先回答。" />
        </h2>
        <div className="mt-10 flex justify-center">
          <DownloadAction />
        </div>
        <div className="mx-auto mt-16 -mb-[14px] w-[200px] md:mt-20 md:-mb-[17px] md:w-[240px]">
          <Island.WakingMochi />
        </div>
      </div>
      <div>
        <p className="site-container py-6 text-center font-brand text-small text-muted">
          我在群里等你。
        </p>
      </div>
    </section>
  );
}

export function Home() {
  return (
    <Shell>
      <Hero />
      <Meet />
      <Roles />
      <Week />
      <Trust />
      <Companions />
      <Start />
      <Questions />
      <Closing />
    </Shell>
  );
}
