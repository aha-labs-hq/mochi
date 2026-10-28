import type { CSSProperties, ReactNode } from "react";
import {
  type Person,
  participants,
} from "../../../controlApp/src/ui/introductionContent.ts";
import type { Picture as PictureData } from "../../build/pictures.ts";
import { useSite } from "../context.ts";
import { needs, releaseName, tagline } from "../facts.ts";
import { questions } from "../faq.ts";
import { Island } from "../islands/index.tsx";
import { Shell } from "../layout.tsx";
import { art, avatars } from "../media.ts";
import { cast, entranceStage } from "../motion.ts";
import {
  cn,
  DownloadAction,
  Kicker,
  Phrases,
  Picture,
  Route,
  reveal,
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
    <h2
      id={id}
      className={cn(
        "text-[28px] leading-[40px] font-semibold tracking-[-0.015em] md:text-[40px] md:leading-[54px]",
        className,
      )}
    >
      <Phrases text={text} />
    </h2>
  );
}

function Hero() {
  const { release } = useSite();
  return (
    <section aria-labelledby="hero-title" className="relative overflow-x-clip">
      {/* A soft daylight where Mochi lands; the page stays paper elsewhere. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[1100px] bg-[radial-gradient(58%_40%_at_50%_82%,var(--color-card),transparent_72%)]"
      />
      <div className="site-container relative flex flex-col items-center pt-12 text-center md:pt-10">
        <p className="mb-7 inline-flex items-center gap-2.5 rounded-full border border-hairline bg-card/70 py-1 pr-3.5 pl-3 text-caption text-muted shadow-[0_1px_2px_#0000000a] md:mb-5 md:text-small">
          <span className="inline-flex items-center gap-1.5 font-medium text-ink">
            <span
              className="size-1.5 rounded-full bg-status-good"
              aria-hidden
            />
            {release ? releaseName(release) : "内测中"}
          </span>
          <span className="h-3 w-px bg-hairline" aria-hidden />
          <span>麻薯 · {tagline}</span>
        </p>
        <h1
          id="hero-title"
          className="text-[34px] leading-[46px] font-semibold tracking-[-0.025em] md:text-[60px] md:leading-[76px] lg:text-[68px] lg:leading-[84px]"
        >
          跑得快的团队，
          <br />
          都共享同一份项目全貌
        </h1>
        <p className="mt-6 max-w-[31em] text-lead text-muted md:mt-5">
          <Phrases text="在飞书群里 @麻薯，|它从你们选定的 GitHub 项目里找答案，|附上出处；|聊定的事，|经你同意写成有负责人的 Issue。" />
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-x-5 gap-y-3 md:mt-7">
          <DownloadAction />
          <Route href="#roles" glyph="arrowDown">
            看看它怎么和你一起工作
          </Route>
        </div>
        <ul className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-caption text-muted md:mt-5">
          {["用你自己的 ChatGPT", "在你的 Mac 上运行", "只看你选的项目"].map(
            (fact) => (
              <li key={fact} className="flex items-center gap-2">
                <span className="size-1 rounded-full bg-muted/60" aria-hidden />
                {fact}
              </li>
            ),
          )}
        </ul>
        <div className="w-full max-w-[860px] text-left">
          <Island.HeroStage stage={entranceStage} />
        </div>
      </div>
    </section>
  );
}

/** A morning in a group without shared context: the questions pile up. */
const noise: {
  who: Person;
  time: string;
  text: string;
  x: number;
  y: number;
  turn: number;
  tax?: string;
  far?: boolean;
}[] = [
  {
    who: "nora",
    time: "10:02",
    text: "这个上线了吗？谁知道？",
    x: 3,
    y: 6,
    turn: -1.5,
    tax: "找人税",
  },
  {
    who: "theo",
    time: "10:05",
    text: "@Evan 在吗？问个事",
    x: 56,
    y: 0,
    turn: 1.5,
    far: true,
  },
  {
    who: "jules",
    time: "10:11",
    text: "上次怎么定的来着？",
    x: 44,
    y: 22,
    turn: 1,
    tax: "断片税",
  },
  {
    who: "evan",
    time: "10:13",
    text: "在开会，晚点看",
    x: 0,
    y: 36,
    turn: -2,
    far: true,
  },
  {
    who: "riley",
    time: "10:20",
    text: "现在到哪了？卡在哪？",
    x: 12,
    y: 55,
    turn: -1,
    tax: "重述税",
  },
  {
    who: "nora",
    time: "10:26",
    text: "私密链接还要登录吗？",
    x: 60,
    y: 45,
    turn: 2,
    far: true,
  },
  {
    who: "theo",
    time: "10:40",
    text: "设计稿是最新那版吗？",
    x: 50,
    y: 68,
    turn: -1.5,
  },
  {
    who: "jules",
    time: "10:52",
    text: "这个需求之前是不是暂缓过？",
    x: 2,
    y: 80,
    turn: 1.5,
    far: true,
  },
];

const taxes = [
  [
    "找人税",
    "一个简单的问题，要先想清楚该问谁，再等对方从手头的事里抽身。答案其实就在 GitHub 里，只是你看不懂，也找不到。",
  ],
  [
    "断片税",
    "群里聊出了结论，消息一刷就没了。下周有人再问，没人说得清当时为什么这么定、该谁去做。",
  ],
  [
    "重述税",
    "每次问进展，都要有人把来龙去脉重讲一遍。研发写日报，负责人开同步会，信息还是慢一拍。",
  ],
] as const;

/* Small screens keep the near questions, staggered left and right. */
const near = noise.filter((item) => !item.far);

function Taxes() {
  return (
    <Section id="taxes" labelledBy="taxes-title">
      <div className="site-grid items-center gap-y-14">
        <div className="col-span-4 md:col-span-10 lg:col-span-5">
          <Kicker index="01">为什么总是慢一拍</Kicker>
          <Display id="taxes-title" text="每个团队都在交的|三笔税" />
          <p className="mt-7 text-lead text-muted">
            <Phrases text="问一句，要先找对人；|聊完了，没人接着做；|问进展，又得从头讲一遍。" />
          </p>
        </div>
        <div
          data-observe
          data-noise
          aria-label="一个上午，群里堆起来的问题（示例）"
          role="img"
          className="relative col-span-4 flex flex-col gap-3 py-2 md:col-span-10 md:block md:h-[480px] md:py-0 lg:col-span-7"
        >
          {noise.map((item, index) => {
            const person = participants[item.who];
            return (
              <figure
                key={item.text}
                data-bubble
                style={
                  {
                    "--x": `${item.x}%`,
                    "--y": `${item.y}%`,
                    rotate: `${item.turn}deg`,
                    "--i": index,
                  } as CSSProperties
                }
                className={cn(
                  "relative m-0 flex max-w-[86%] items-start gap-2 md:absolute md:top-(--y) md:left-(--x) md:max-w-[60%] md:self-auto",
                  near.indexOf(item) % 2 ? "self-end" : "self-start",
                  item.far ? "z-0 hidden scale-[.93] md:flex" : "z-10",
                  item.tax && "z-20",
                )}
              >
                <span className="block size-7 shrink-0 overflow-hidden rounded-full bg-note">
                  <Picture
                    picture={avatars[item.who]}
                    alt=""
                    sizes="28px"
                    className="size-full"
                  />
                </span>
                <div
                  className={cn(
                    "relative rounded-[4px_14px_14px_14px] px-3.5 py-2 shadow-[0_1px_2px_#0000000f,0_10px_24px_-14px_#00000033]",
                    item.far ? "bg-card/70 text-ink/55" : "bg-card",
                  )}
                >
                  <p className="text-[11px] leading-4 text-muted">
                    {person.name} · {item.time}
                  </p>
                  <p className="mt-0.5 text-[15px] leading-6 whitespace-nowrap">
                    {item.text}
                  </p>
                  {item.tax && (
                    <span
                      data-tag
                      className="absolute -top-3 -right-3 rounded-full bg-ink px-2.5 py-0.5 text-[12px] leading-5 font-medium text-card shadow-sm"
                    >
                      {item.tax}
                    </span>
                  )}
                </div>
              </figure>
            );
          })}
        </div>
      </div>
      <div className="mt-16 grid gap-10 md:mt-20 md:grid-cols-3 md:gap-0">
        {taxes.map(([name, words], index) => (
          <article
            key={name}
            {...reveal(index * 90)}
            className="md:border-l md:border-hairline md:px-8 md:first:border-l-0 md:first:pl-0 md:last:pr-0"
          >
            <h3 className="inline-flex rounded-full bg-ink px-3 py-0.5 text-small font-medium text-card">
              {name}
            </h3>
            <p className="mt-4 text-muted">{words}</p>
          </article>
        ))}
      </div>
    </Section>
  );
}

const queue = [
  ["10:02", "运营", "公开链接能发给客户了吗？"],
  ["10:15", "产品", "我问下研发。"],
  ["11:40", "研发", "刚开完会。PR 合了，上没上线我看下。"],
  ["14:30", "研发", "确认已经上线了。"],
  ["14:32", "运营", "邀请推到下午才发出去。"],
] as const;
const direct = [
  ["10:02", "运营", "@麻薯 公开链接能发给客户了吗？"],
  ["10:04", "麻薯", "能，已经上线了。附上发布记录和当时定的范围。"],
  ["10:06", "运营", "邀请发出去了。"],
] as const;

/* An illustration, not a measurement: the timelines compare, no total does. */
function Race({
  label,
  minutes,
  events,
  fast,
}: {
  label: string;
  minutes: number;
  events: readonly (readonly [string, string, string])[];
  fast: boolean;
}) {
  return (
    <div>
      <p
        className={cn(
          "text-[17px] leading-7 font-semibold",
          fast ? "text-glow" : "text-card",
        )}
      >
        {label}
      </p>
      <div className="mt-5 h-1 rounded-full bg-card/10" aria-hidden>
        <div
          data-bar
          className={cn("h-full rounded-full", fast ? "bg-glow" : "bg-card/45")}
          style={
            {
              "--share": minutes / 270,
              "--duration": fast ? "240ms" : "2600ms",
            } as CSSProperties
          }
        />
      </div>
      <ol className="mt-7 space-y-2.5 text-small">
        {events.map(([time, who, words]) => (
          <li
            key={time + words}
            className="grid grid-cols-[48px_40px_minmax(0,1fr)] gap-2"
          >
            <span className="font-brand text-card/55 tabular-nums">{time}</span>
            <span
              className={
                who === "麻薯" ? "font-medium text-glow" : "text-card/55"
              }
            >
              {who}
            </span>
            <span className="text-card/85">{words}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Divide() {
  return (
    <section aria-labelledby="divide-title" className="bg-ink text-card">
      <div className="site-container py-24 md:py-36">
        <p className="mb-6 flex items-baseline gap-3 text-small text-card/55 md:mb-8">
          <span className="font-brand font-medium text-card tabular-nums">
            02
          </span>
          <span
            className="h-px w-8 translate-y-[-4px] bg-card/20"
            aria-hidden
          />
          <span>差距从哪里来</span>
        </p>
        <h2
          id="divide-title"
          className="max-w-[20em] text-[28px] leading-[40px] font-semibold tracking-[-0.015em] md:text-[44px] md:leading-[60px]"
        >
          <Phrases text="这些税不会出现在|任何报表里，|但每天都在交。" />
        </h2>
        <p className="mt-5 text-small text-card/80">
          示意：同一个周一上午的两种情形，不是实测数据。
        </p>
        <div
          data-observe
          className="mt-14 grid gap-16 md:mt-20 md:grid-cols-2 md:gap-12 lg:gap-24"
        >
          <Race
            label="还在排队问人的团队"
            minutes={270}
            events={queue}
            fast={false}
          />
          <Race
            label="人人都能直接问项目的团队"
            minutes={4}
            events={direct}
            fast
          />
        </div>
        <p className="mt-20 border-t border-card/15 pt-10 text-[22px] leading-9 font-semibold md:text-[30px] md:leading-[44px]">
          <Phrases text="AI 人人都有了。|差距在于，|你们的项目，|AI 读不读得懂。" />
        </p>
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
    <Section id="meet" labelledBy="meet-title">
      <div className="site-grid items-center gap-y-14">
        <div className="col-span-4 md:col-span-8 md:col-start-3 lg:order-2 lg:col-span-6 lg:col-start-7">
          <Picture
            picture={art.folio}
            alt="一本打开的毛毡项目册：左页是讨论和确认，右页是代码和工作看板"
            sizes="(min-width: 1024px) 560px, 90vw"
            className="h-auto w-full"
          />
        </div>
        <div className="col-span-4 md:col-span-10 lg:order-1 lg:col-span-5">
          <Kicker index="03">认识麻薯</Kicker>
          <Display
            id="meet-title"
            text="它住在你们的飞书群里，|读得懂你们的项目"
          />
          <p className="mt-7 text-lead text-muted">
            应用叫 Mochi，默认的伙伴叫麻薯。把麻薯带入飞书与
            GitHub，让讨论、决策、代码和项目状态串成清晰脉络，每个判断都有迹可循。谁都可以
            @ 它，用平常说话的方式。
          </p>
          <dl className="mt-10 border-t border-hairline">
            {verbs.map(([verb, words], index) => (
              <div
                key={verb}
                {...reveal(index * 80)}
                className="grid grid-cols-[88px_minmax(0,1fr)] gap-4 border-b border-hairline py-5"
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
      <Kicker index="04">按职能看</Kicker>
      <Display id="roles-title" text="你平时在团队里|做什么？" />
      <p className="mt-5 mb-12 text-lead text-muted md:mb-16">
        选一个最接近的，看看麻薯怎么和你一起工作。
      </p>
      <Island.RoleStories initial="lead" />
      <div className="mt-14 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-hairline pt-10">
        <p className="mr-auto text-lead">想在你们的群里试试？</p>
        <DownloadAction />
      </div>
    </Section>
  );
}

function Week() {
  return (
    <Section id="week" labelledBy="week-title">
      <Kicker index="05">一条线上</Kicker>
      <Display id="week-title" text="同一件事，|从聊定到上线" />
      <p className="mt-5 max-w-[30em] text-lead text-muted">
        往下滚，看麻薯在一周里怎么接住、怎么回答、怎么跟进。
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
    words: "GitHub 项目、飞书群、共享邮箱，都要你明确打开才会用到。",
  },
  {
    icon: art.icons.issue,
    title: "代码和 PR 只读",
    words: (
      <>
        唯一会写的是 Issue，每次修改都先核对授权，并留下记录。GitHub
        安装页列出的权限更宽，原因见
        <a
          href="/admin/#github"
          className="text-primary underline underline-offset-4"
        >
          给管理员的说明
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
      <Kicker index="06">安全与边界</Kicker>
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
      <ul className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 sm:gap-y-12 md:mt-20 lg:grid-cols-3">
        {promises.map((item, index) => (
          <li
            key={item.title}
            {...reveal((index % 3) * 80)}
            className="group grid grid-cols-[48px_minmax(0,1fr)] gap-x-5 border-t border-hairline pt-6 sm:block"
          >
            <span className="row-span-2">
              <Picture
                picture={item.icon}
                alt=""
                sizes="56px"
                className="size-12 transition-transform duration-500 ease-(--ease-settle) group-hover:-translate-y-1 group-hover:-rotate-6 motion-reduce:transition-none sm:size-14"
              />
            </span>
            <h3 className="text-[17px] leading-7 font-semibold sm:mt-5">
              {item.title}
            </h3>
            <p className="mt-1 text-muted sm:mt-2">{item.words}</p>
          </li>
        ))}
      </ul>
      <div className="mt-16 flex flex-col gap-6 rounded-card bg-card p-7 shadow-card md:flex-row md:items-center md:justify-between md:p-8">
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
          <Kicker index="07">伙伴</Kicker>
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
      <Kicker index="08">开始</Kicker>
      <Display id="start-title" text="三步，|把麻薯请进群" />
      <div className="site-grid mt-14 gap-y-12 md:mt-20">
        <div className="col-span-4 md:col-span-10 lg:col-span-4">
          <div className="rounded-card bg-card p-6 shadow-card md:p-7">
            <p className="text-[17px] leading-7 font-semibold">
              开始之前，准备好
            </p>
            <ul className="mt-4 space-y-3 text-[15px] leading-[25px]">
              {needs(release).map((need) => (
                <li key={need} className="flex gap-3">
                  <span
                    className="mt-[9px] size-1.5 shrink-0 rounded-full bg-primary"
                    aria-hidden
                  />
                  {need}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <ol className="col-span-4 grid gap-10 md:col-span-12 md:grid-cols-3 lg:col-span-8 lg:col-start-5 lg:gap-8">
          {steps.map(([title, words], index) => (
            <li
              key={title}
              {...reveal(index * 90)}
              className="border-t border-ink pt-5"
            >
              <p className="font-brand text-[44px] leading-none font-semibold text-ink tabular-nums">
                {index + 1}
              </p>
              <h3 className="mt-6 text-[17px] leading-7 font-semibold">
                {title}
              </h3>
              <p className="mt-2 text-muted">{words}</p>
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
          <Kicker index="09">常见问题</Kicker>
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
        <div className="col-span-4 border-t border-hairline md:col-span-12 lg:col-span-7 lg:col-start-6">
          {questions.map(([question, answer]) => (
            <details key={question} className="group border-b border-hairline">
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
      className="border-t border-hairline pt-24 md:pt-36"
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
      <div className="border-t border-hairline">
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
      <Taxes />
      <Divide />
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
