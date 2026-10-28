import { type ReactNode, useEffect, useRef, useState } from "react";
import { Transcript, useEvidence } from "../conversation.tsx";
import { type Thread, threads, weekSteps } from "../threads.ts";
import { cn } from "../ui.tsx";

const steps: { title: string; body: string; aside: ReactNode }[] = [
  {
    title: "聊出来的结论，有人接住",
    body: "在话题里说一声“派给 Evan”，麻薯会先看有没有相同的 Issue，再决定更新还是新建，写上负责人，附上飞书原消息的链接。",
    aside: (
      <ul className="space-y-2.5">
        {[
          "只在有人明确交代时才写入",
          "代码和 PR 只读不改",
          "每次写入都以 Mochi 的身份留下记录",
        ].map((line) => (
          <li key={line} className="flex items-center gap-2.5">
            <span
              className="size-1.5 rounded-full bg-status-good"
              aria-hidden
            />
            {line}
          </li>
        ))}
      </ul>
    ),
  },
  {
    title: "它不装懂",
    body: "每个结论都附上出处：哪条 Issue、哪个 PR、哪次发布。确认了的说已确认，查不到的直说还不能确定，读不了的资料会告诉你缺了什么。",
    aside: "直接问 ChatGPT，它不知道你们的项目。问麻薯，它先去项目里查。",
  },
  {
    title: "交代一次，到点接着做",
    body: "一次性的检查、每天的整理、每周的发布核对，都可以在群里用一句话交代。到点后，结果发回原来的群，自成一条完整的消息。",
    aside: "麻薯在你的 Mac 上值班。Mac 关机、休眠或断网时，安排不能准点执行。",
  },
];

/** A slice of the week, for small screens where nothing stays pinned. */
function slice(from: number, to: number): Thread {
  return { ...threads.week, lines: threads.week.lines.slice(from, to) };
}

/**
 * One week of the same request. On wide screens the group stays in view while
 * the reader scrolls through three steps, and each step appends that day's
 * messages: history is never rewritten, as in a real group.
 */
export function StoryScroll() {
  const [step, setStep] = useState(steps.length - 1);
  const blocks = useRef<(HTMLElement | null)[]>([]);
  const history = useRef<HTMLDivElement>(null);
  const { inspect, view } = useEvidence();

  useEffect(() => {
    setStep(0);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting)
            setStep(Number((entry.target as HTMLElement).dataset.step));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const block of blocks.current) if (block) observer.observe(block);
    return () => observer.disconnect();
  }, []);

  // Keep the latest message in view as the week unfolds.
  const shown = weekSteps[step] ?? threads.week.lines.length;
  useEffect(() => {
    const node = history.current;
    const latest = node?.children[shown - 1] as HTMLElement | undefined;
    if (!node || !latest) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollTo({
      top: latest.offsetTop + latest.offsetHeight - node.clientHeight + 24,
      behavior: reduce ? "auto" : "smooth",
    });
  }, [shown]);

  return (
    <div className="site-grid gap-y-10">
      <ol className="col-span-4 md:col-span-10 lg:col-span-5">
        {steps.map((item, index) => (
          <li
            key={item.title}
            ref={(node) => {
              blocks.current[index] = node;
            }}
            data-step={index}
            className="flex flex-col justify-center py-10 lg:min-h-[58svh] lg:py-0"
          >
            <div>
              <p
                className={cn(
                  "mb-4 font-brand text-small text-muted tabular-nums transition-colors duration-300",
                  index === step && "text-primary",
                )}
              >
                {["把决定留下", "把进展查清", "把后续交代好"][index]}
              </p>
              <h3 className="text-[24px] leading-[34px] font-semibold tracking-[-0.01em] md:text-[30px] md:leading-[42px]">
                {item.title}
              </h3>
              <p className="mt-5 text-lead text-muted">{item.body}</p>
              <div className="mt-6 text-small text-muted">{item.aside}</div>
            </div>
            <div className="mt-8 rounded-card bg-card px-4 py-5 shadow-card lg:hidden">
              <Transcript
                thread={slice(
                  index === 0 ? 0 : weekSteps[index - 1]!,
                  weekSteps[index]!,
                )}
                inspect={inspect}
              />
            </div>
          </li>
        ))}
      </ol>
      <div className="hidden lg:col-span-7 lg:block">
        <div className="sticky top-24 flex h-[min(720px,calc(100dvh-128px))] flex-col rounded-card bg-card px-7 pt-7 pb-3 shadow-card">
          <header className="mb-1 pb-4">
            <p className="mb-1.5 text-caption text-muted">
              示例对话：同一件事的一周
            </p>
            <h3 className="text-[17px] leading-6 font-medium">
              {threads.week.title}
            </h3>
          </header>
          {/* The scrollable transcript needs a keyboard entry point. */}
          <div
            ref={history}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll this bounded transcript.
            tabIndex={0}
            role="log"
            aria-label={`对话示例：${threads.week.title}`}
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain py-4 [scrollbar-width:none] [mask-image:linear-gradient(to_bottom,transparent,#000_16px,#000_calc(100%-24px),transparent)]"
          >
            <Transcript thread={threads.week} shown={shown} inspect={inspect} />
          </div>
        </div>
      </div>
      {view}
    </div>
  );
}
