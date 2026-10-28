import { animate, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./Controls.tsx";
import { Glyph } from "./Glyph.tsx";
import { IntroductionMarkdown } from "./IntroductionMarkdown.tsx";
import {
  introductionContent as content,
  type Evidence,
  type Person,
  participants,
  type Story,
} from "./introductionContent.ts";
import { introductionPlayback } from "./introductionPlayback.ts";
import { ProjectIllustration } from "./ProjectIllustration.tsx";
import { cn } from "./styles.ts";

const ease = [0.22, 1, 0.36, 1] as const;
const reduced = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const avatarClass = "block size-full rounded-lg object-cover";

export function Introduction({
  begin,
  modalOpen,
  moving,
  arriving = false,
  resize,
}: {
  begin(): void;
  modalOpen: boolean;
  moving: boolean;
  arriving?: boolean;
  resize(height: number | null): void;
}) {
  const [scene, setScene] = useState<"welcome" | "choice" | Story>("welcome");
  const story = typeof scene === "object" ? scene : null;
  const welcome = scene === "welcome";
  const view = story ? "chat" : welcome ? "welcome" : "choice";
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pageContent = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const promise = useRef<HTMLDivElement>(null);
  const welcomeAction = useRef<HTMLDivElement>(null);
  const choice = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const history = useRef<HTMLElement>(null);
  const latest = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const flight = useRef<HTMLDivElement>(null);
  const destination = useRef<HTMLSpanElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeSource = useRef<HTMLButtonElement>(null);
  const announcement = useRef<HTMLSpanElement>(null);
  const sourceOrigin = useRef<HTMLAnchorElement | null>(null);
  const portraits = useRef(
    new Map<string, { node: HTMLImageElement; home: HTMLElement }>(),
  );
  const identity = useRef<{ node: HTMLImageElement; box: DOMRect } | null>(
    null,
  );
  const playback = useRef<ReturnType<typeof introductionPlayback> | null>(null);
  const transitions = useRef<ReturnType<typeof animate>[]>([]);
  const scroll = useRef<ReturnType<typeof animate> | null>(null);
  const lastRole = useRef<string | null>(null);
  const previousView = useRef<typeof view | null>(null);
  const navigation = useRef<ReturnType<typeof animate> | null>(null);
  const unavailable = modalOpen || moving || arriving;
  const blocked = useRef(unavailable);
  blocked.current = unavailable;

  const edges = useCallback(() => {
    const node = history.current;
    if (!node) return;
    node.dataset.top = String(node.scrollTop > 1);
    node.dataset.bottom = String(
      node.scrollHeight - node.clientHeight - node.scrollTop > 2,
    );
    if (latest.current) {
      const visible =
        node.dataset.conversation === "complete" &&
        node.dataset.bottom === "true";
      latest.current.inert = !visible;
      latest.current.dataset.visible = String(visible);
    }
  }, []);
  const restorePortrait = useCallback(() => {
    for (const { node, home } of portraits.current.values()) {
      home.append(node);
      node.removeAttribute("style");
    }
    identity.current = null;
    if (panel.current) panel.current.dataset.avatarTransition = "idle";
  }, []);

  useLayoutEffect(() => {
    // These empty portrait hosts belong to React; this effect alone owns each
    // image node, allowing it to travel without React replacing its identity.
    const nodes = portraits.current;
    for (const item of content.stories) {
      const home = choice.current!.querySelector<HTMLElement>(
        `[data-portrait="${item.perspective}"]`,
      )!;
      const node = new Image(56, 56);
      node.src = participants[item.perspective as Person].avatar;
      node.alt = "";
      node.className = avatarClass;
      node.dataset.personAvatar = item.perspective;
      home.append(node);
      nodes.set(item.id, { node, home });
    }
    return () => {
      for (const { node } of nodes.values()) node.remove();
      nodes.clear();
    };
  }, []);

  useLayoutEffect(() => {
    if (!unavailable) heading.current?.focus({ preventScroll: true });
  }, [unavailable]);

  useLayoutEffect(() => {
    const frame = panel.current!;
    const historyNode = history.current;
    const active =
      story && historyNode
        ? introductionPlayback(historyNode, edges, (text) => {
            if (announcement.current) announcement.current.textContent = text;
          })
        : null;
    playback.current = active;
    const still = reduced();
    if (still) {
      pageContent.current!.style.opacity = "1";
      pageContent.current!.style.transform = "none";
    }
    let width = frame.clientWidth;
    const desiredHeight = () => {
      if (story) return width <= 400 ? 548 : 520;
      const style = getComputedStyle(frame);
      const content = (welcome ? promise : choice).current!;
      // scrollHeight rounds fractional layout down at some widths, clipping the
      // last action. Measure its actual bottom before rounding the whole frame.
      const contentHeight =
        content.lastElementChild!.getBoundingClientRect().bottom -
        content.getBoundingClientRect().top +
        content.scrollTop;
      return Math.ceil(
        Number.parseFloat(style.paddingTop) +
          heading.current!.getBoundingClientRect().height +
          Number.parseFloat(getComputedStyle(body.current!).marginTop) +
          contentHeight +
          (welcome
            ? welcomeAction.current!.getBoundingClientRect().height +
              Number.parseFloat(
                getComputedStyle(welcomeAction.current!).marginTop,
              )
            : 0) +
          Number.parseFloat(style.paddingBottom),
      );
    };
    const finalHeight = desiredHeight();
    const startHeight = frame.getBoundingClientRect().height;
    const movingPortrait = identity.current;
    const settle = () => {
      for (const animation of transitions.current) animation.complete();
    };
    const start = () => {
      if (!active) return;
      active.pause(
        blocked.current || document.hidden || dialog.current?.open === true,
      );
      if (reduced()) active.read();
      else active.start();
    };
    transitions.current = [];
    if (still || arriving || previousView.current === null) resize(finalHeight);
    else
      transitions.current.push(
        animate(startHeight, finalHeight, {
          duration: 0.36,
          ease,
          onUpdate: resize,
        }),
      );
    if (active && movingPortrait && destination.current) {
      const row = destination.current.closest<HTMLElement>("[data-message]")!;
      row.hidden = false;
      row.style.opacity = "0";
      const target = destination.current.getBoundingClientRect();
      const origin = frame.getBoundingClientRect();
      const { node, box } = movingPortrait;
      Object.assign(node.style, {
        position: "absolute",
        left: `${box.left - origin.left}px`,
        top: `${box.top - origin.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        transformOrigin: "0 0",
      });
      const land = () => {
        destination.current?.append(node);
        node.removeAttribute("style");
        frame.dataset.avatarTransition = "landed";
      };
      frame.dataset.avatarTransition = "flying";
      if (still) {
        land();
        start();
      } else {
        transitions.current.push(
          animate(
            node,
            {
              x: target.left - box.left,
              y: target.top - box.top,
              scale: target.width / box.width,
            },
            { duration: 0.56, ease, onComplete: land },
          ),
        );
        transitions.current.push(
          animate(0, 1, { duration: 0.4, onComplete: start }),
        );
      }
      back.current?.focus({ preventScroll: true });
    } else if (active) start();
    if (!still && previousView.current !== null)
      transitions.current.push(
        animate(
          pageContent.current!,
          { opacity: [0, 1], x: [6, 0] },
          { duration: 0.28, ease },
        ),
      );
    if (view === "choice" && lastRole.current)
      choice.current
        ?.querySelector<HTMLButtonElement>(`[data-role="${lastRole.current}"]`)
        ?.focus({ preventScroll: true });
    else if (!story && !blocked.current)
      heading.current?.focus({ preventScroll: true });
    previousView.current = view;

    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      const nextWidth = frame.clientWidth;
      if (Math.abs(nextWidth - width) > 1) {
        width = nextWidth;
        // Native handoff changes width continuously. Commit the dependent
        // height on the next paint, outside ResizeObserver's delivery cycle.
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          settle();
          active?.read();
          resize(desiredHeight());
        });
      }
      // Height follows the shared frame animation; it must not finish playback.
      edges();
    });
    observer.observe(frame);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motionChanged = () => {
      if (preference.matches) {
        navigation.current?.complete();
        settle();
        active?.read();
      }
    };
    const visibility = () => {
      if (document.hidden) settle();
      active?.pause(
        document.hidden || blocked.current || dialog.current?.open === true,
      );
    };
    preference.addEventListener("change", motionChanged);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      preference.removeEventListener("change", motionChanged);
      document.removeEventListener("visibilitychange", visibility);
      active?.dispose();
      for (const animation of transitions.current) animation.stop();
      scroll.current?.stop();
    };
  }, [story, welcome, view, resize, edges, arriving]);

  useEffect(() => {
    playback.current?.pause(
      unavailable || evidence !== null || document.hidden,
    );
  }, [unavailable, evidence]);
  useLayoutEffect(
    () => () => {
      navigation.current?.stop();
      resize(null);
    },
    [resize],
  );

  const inspect = useCallback((id: string, origin: HTMLAnchorElement) => {
    const selected = content.evidence.find((item) => item.id === id);
    if (!selected) throw new Error(`Unknown introduction source: ${id}`);
    sourceOrigin.current = origin;
    playback.current?.pause(true);
    setEvidence(selected);
  }, []);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!evidence || unavailable) {
      node.close();
      return;
    }
    const position = () => {
      const box = panel.current!.getBoundingClientRect();
      Object.assign(node.style, {
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
    };
    position();
    node.showModal();
    closeSource.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(panel.current!);
    const animation = reduced()
      ? null
      : animate(node, { opacity: [0, 1], y: [6, 0] }, { duration: 0.2, ease });
    return () => {
      observer.disconnect();
      animation?.stop();
    };
  }, [evidence, unavailable]);

  const choose = (item: Story) => {
    if (unavailable || navigation.current) return;
    for (const animation of transitions.current) animation.complete();
    const portrait = portraits.current.get(item.id)!;
    identity.current = {
      node: portrait.node,
      box: portrait.node.getBoundingClientRect(),
    };
    flight.current!.append(portrait.node);
    lastRole.current = item.id;
    setScene(item);
  };
  const returnToChoice = () => {
    for (const animation of transitions.current) animation.stop();
    playback.current?.dispose();
    restorePortrait();
    setScene("choice");
  };
  const navigate = (next: "welcome" | "choice") => {
    if (blocked.current || navigation.current) return;
    for (const animation of transitions.current) animation.complete();
    if (reduced()) {
      setScene(next);
      return;
    }
    navigation.current = animate(
      pageContent.current!,
      { opacity: 0, x: -6 },
      {
        duration: 0.12,
        ease,
        onComplete: () => {
          navigation.current = null;
          setScene(next);
        },
      },
    );
  };
  const read = () => {
    for (const animation of transitions.current) animation.complete();
    scroll.current?.stop();
    playback.current?.read();
  };

  return (
    <section
      data-testid="introduction"
      data-arriving={arriving}
      className="absolute inset-0 z-1 text-ink"
    >
      <motion.div
        ref={panel}
        data-intro-view={view}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: arriving ? 0 : 1, y: arriving ? 8 : 0 }}
        transition={{ duration: reduced() ? 0 : 0.7, ease }}
        className="absolute top-(--felt-top) left-1/2 flex h-(--felt-height) w-(--felt-width) -translate-x-1/2 flex-col px-8 pt-7 pb-6 @max-[440px]/presentation:px-4 @max-[440px]/presentation:pt-5 @max-[440px]/presentation:pb-4"
        inert={unavailable}
        style={{ visibility: arriving ? "hidden" : "visible" }}
      >
        <div ref={pageContent} className="flex min-h-0 flex-1 flex-col">
          {story && (
            <p className="mb-2 flex shrink-0 items-center justify-between text-xs leading-[18px] text-muted">
              <span>{story.role}视角</span>
              <span>对话示例</span>
            </p>
          )}
          <h1
            ref={heading}
            id="intro-heading"
            tabIndex={-1}
            className={cn(
              "shrink-0 font-medium tracking-normal text-balance outline-none",
              welcome
                ? "text-hero leading-[44px] @max-[440px]/presentation:text-title @max-[440px]/presentation:leading-[34px]"
                : story
                  ? "text-heading leading-7 @max-[440px]/presentation:text-subheading @max-[440px]/presentation:leading-[26px]"
                  : "text-title leading-8 @max-[440px]/presentation:text-heading @max-[440px]/presentation:leading-8",
            )}
          >
            {welcome
              ? content.heading.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))
              : (story?.title ?? content.question)}
          </h1>
          <div
            ref={body}
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              welcome ? "mt-0" : story ? "mt-5" : "mt-2",
            )}
          >
            <div
              ref={promise}
              hidden={!welcome}
              className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <ProjectIllustration active={welcome && !unavailable} />
              <p className="mb-2 text-base leading-6 text-pretty text-ink @max-[440px]/presentation:mb-1.5 @max-[440px]/presentation:leading-[22px]">
                {content.who}
              </p>
              <p className="text-base leading-6 text-pretty text-muted @max-[440px]/presentation:leading-[22px]">
                <span className="block text-ink">{content.intro}</span>
                {content.context}
                <span className="block text-ink">{content.caption}</span>
              </p>
            </div>
            <div
              ref={welcomeAction}
              hidden={!welcome}
              className="mt-6 shrink-0 border-t border-hairline pt-3 @max-[440px]/presentation:mt-5"
            >
              <Button
                variant="text"
                className="group m-0 inline-flex min-h-11 w-full items-center justify-between gap-4 rounded-lg px-0 py-1 text-base font-medium text-action"
                onClick={() => navigate("choice")}
              >
                {content.explore}
                <span className="flex size-8 items-center justify-center rounded-full bg-action-soft transition-colors duration-150 group-hover:bg-action group-hover:text-on-primary motion-reduce:transition-none">
                  <Glyph name="arrowRight" size={16} />
                </span>
              </Button>
            </div>
            <div
              ref={choice}
              hidden={view !== "choice"}
              className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <p className="text-base leading-[22px] text-pretty text-muted">
                {content.choiceHint}
              </p>
              <fieldset
                aria-labelledby="intro-heading"
                className="mt-6 min-w-0 border-0 border-t border-hairline p-0 pt-6"
              >
                <div className="grid grid-cols-[repeat(5,56px)] justify-between gap-y-5 @max-[440px]/presentation:grid-cols-[repeat(3,56px)]">
                  {content.stories.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      data-role={item.id}
                      onClick={() => choose(item)}
                      className="group flex h-[90px] w-14 cursor-pointer flex-col items-center gap-3 rounded-lg control-focus"
                    >
                      <span
                        data-portrait={item.perspective}
                        className="block size-14 shrink-0 rounded-lg transition-[filter] group-hover:brightness-95 motion-reduce:transition-none"
                      />
                      <span className="text-base leading-[22px] font-medium whitespace-nowrap">
                        {item.role}
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <Button
                variant="text"
                className="mt-5 mb-0 inline-flex h-10 items-center gap-1.5 rounded-lg px-0 py-0 font-normal text-muted"
                onClick={() => navigate("welcome")}
              >
                <Glyph name="arrowLeft" size={16} />
                认识麻薯
              </Button>
            </div>
            {story && (
              <>
                <div className="relative flex min-h-0 flex-1 flex-col pb-7">
                  <section
                    key={story.id}
                    ref={history}
                    data-testid="story-thread"
                    data-role={story.id}
                    data-journey-scroll
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard readers need to scroll and take over this transcript.
                    tabIndex={0}
                    aria-label="完整对话示例"
                    onScroll={edges}
                    onWheel={(event) => {
                      if (event.deltaY !== 0) read();
                    }}
                    onTouchMove={read}
                    onKeyDown={(event) => {
                      if (
                        [
                          "ArrowUp",
                          "ArrowDown",
                          "PageUp",
                          "PageDown",
                          "Home",
                          "End",
                          " ",
                        ].includes(event.key)
                      )
                        read();
                    }}
                    className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [--top-fade:0px] [--bottom-fade:0px] data-[top=true]:[--top-fade:12px] data-[bottom=true]:[--bottom-fade:16px] [mask-image:linear-gradient(to_bottom,transparent,#000_var(--top-fade),#000_calc(100%_-_var(--bottom-fade)),transparent)] focus-visible:rounded-lg control-focus"
                  >
                    {story.messages.map((message, index) => {
                      const person = participants[message.speaker as Person];
                      const self = message.speaker === story.perspective;
                      return (
                        <article
                          key={message.text}
                          data-message={index}
                          data-testid={`story-message-${index}`}
                          data-speaker={message.speaker}
                          data-author={person.name}
                          data-perspective={self}
                          className="mb-[18px] grid shrink-0 grid-cols-[32px_minmax(0,1fr)_32px] grid-rows-[18px_auto] items-start gap-x-2 gap-y-1.5 last:mb-0"
                        >
                          <span
                            ref={index === 0 ? destination : undefined}
                            className={cn(
                              "row-start-2 block size-8",
                              self ? "col-start-3" : "col-start-1",
                            )}
                          >
                            {index !== 0 && (
                              <img
                                src={person.avatar}
                                alt=""
                                width={32}
                                height={32}
                                className={avatarClass}
                              />
                            )}
                          </span>
                          <p
                            className={cn(
                              "col-start-2 row-start-1 flex min-w-0 gap-2 px-3 text-xs leading-[18px] text-muted @max-[440px]/presentation:px-2.5",
                              self && "justify-end",
                            )}
                          >
                            <span>{person.name}</span>
                            {"badge" in person ? (
                              // In Feishu a bot carries this tag; a portrait alone can mislead.
                              <span className="rounded-[4px] bg-ink/7 px-1 text-2xs leading-[18px] text-ink">
                                {person.badge}
                              </span>
                            ) : (
                              <span>{person.role}</span>
                            )}
                          </p>
                          <div
                            data-chat-bubble
                            className={cn(
                              "col-start-2 row-start-2 min-w-0 max-w-full px-3 py-2.5 text-base leading-[22px] @max-[440px]/presentation:px-2.5",
                              self
                                ? "justify-self-end rounded-[8px_4px_8px_8px] bg-control"
                                : "justify-self-start rounded-[4px_8px_8px] bg-card",
                            )}
                          >
                            <IntroductionMarkdown
                              content={message.text}
                              typing={message.speaker === "mochi"}
                              inspect={inspect}
                            />
                          </div>
                        </article>
                      );
                    })}
                  </section>
                  <Button
                    ref={latest}
                    variant="icon"
                    inert
                    data-visible="false"
                    aria-label="回到最新消息"
                    title="回到最新消息"
                    className="group invisible absolute -bottom-2 left-1/2 size-11 -translate-x-1/2 translate-y-1 rounded-full text-muted opacity-0 transition-[opacity,translate,visibility] duration-150 ease-out data-[visible=true]:visible data-[visible=true]:translate-y-0 data-[visible=true]:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none"
                    onClick={() => {
                      const node = history.current!;
                      scroll.current?.stop();
                      scroll.current = animate(
                        node.scrollTop,
                        node.scrollHeight - node.clientHeight,
                        {
                          duration: reduced() ? 0 : 0.32,
                          ease,
                          onUpdate: (top) => {
                            node.scrollTop = top;
                            edges();
                          },
                          onComplete: () => node.focus({ preventScroll: true }),
                        },
                      );
                    }}
                  >
                    <span className="flex size-6 items-center justify-center rounded-full border border-hairline bg-card shadow-control transition-colors group-hover:bg-control group-hover:text-ink motion-reduce:transition-none">
                      <Glyph name="arrowDown" size={14} />
                    </span>
                  </Button>
                </div>
                <div className="flex h-[52px] shrink-0 items-center justify-between gap-2 pt-3">
                  <Button
                    ref={back}
                    variant="text"
                    className="m-0 inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-1 py-0 font-normal text-muted"
                    onClick={returnToChoice}
                  >
                    <Glyph name="arrowLeft" size={16} />
                    重选职能
                  </Button>
                  <Button
                    variant="primary"
                    className="ml-auto inline-flex h-10 shrink-0 items-center gap-3 rounded-lg px-4 py-0 font-normal"
                    onClick={begin}
                  >
                    开始设置
                    <Glyph name="arrowRight" size={16} />
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
        <div
          ref={flight}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-6"
        />
      </motion.div>
      <dialog
        ref={dialog}
        aria-labelledby="intro-source-title"
        onCancel={(event) => {
          event.preventDefault();
          setEvidence(null);
        }}
        onClose={() => {
          setEvidence(null);
          sourceOrigin.current?.focus({ preventScroll: true });
        }}
        className="fixed m-0 max-h-none max-w-none overflow-hidden rounded-2xl border-0 bg-surface px-8 pt-7 pb-6 text-ink backdrop:bg-transparent @max-[440px]/presentation:px-4 @max-[440px]/presentation:pt-5 @max-[440px]/presentation:pb-4"
      >
        {evidence && (
          <div className="flex h-full flex-col">
            <div className="mb-4 flex h-9 shrink-0 items-center justify-between text-xs text-muted">
              <span>GitHub · 示例资料</span>
              <Button
                ref={closeSource}
                variant="icon"
                aria-label="返回对话"
                title="返回对话"
                onClick={() => setEvidence(null)}
              >
                <Glyph name="close" size={18} />
              </Button>
            </div>
            <div className="min-h-0 flex-1 select-text overflow-y-auto text-base leading-[22px] [scrollbar-width:thin]">
              <h2
                id="intro-source-title"
                className="mb-2 text-heading leading-7 font-medium tracking-normal"
              >
                {evidence.title}
              </h2>
              <p className="mb-3.5 text-xs text-muted">{evidence.moment}</p>
              <p>{evidence.state}</p>
              <ul className="my-3.5 list-disc space-y-1.5 pl-5">
                {evidence.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
              {evidence.note && (
                <p className="mt-[18px] border-t border-hairline pt-3.5 text-xs text-muted">
                  {evidence.note}
                </p>
              )}
            </div>
          </div>
        )}
      </dialog>
      <span
        ref={announcement}
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      />
    </section>
  );
}
