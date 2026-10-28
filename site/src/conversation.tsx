import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IntroductionMarkdown } from "../../controlApp/src/ui/IntroductionMarkdown.tsx";
import { participants } from "../../controlApp/src/ui/introductionContent.ts";
import { introductionPlayback } from "../../controlApp/src/ui/introductionPlayback.ts";
import { avatars } from "./media.ts";
import { evidence, type Thread } from "./threads.ts";
import { cn, Glyph, Picture } from "./ui.tsx";

type Controller = ReturnType<typeof introductionPlayback>;

/**
 * The transcript markup the companion's playback already knows how to play.
 * `shown` limits an unfolding thread to its first lines; each later line
 * settles in as it joins, and earlier ones never change.
 */
export function Transcript({
  thread,
  typing = false,
  shown,
  inspect,
}: {
  thread: Thread;
  typing?: boolean;
  shown?: number;
  inspect(id: string, origin: HTMLAnchorElement): void;
}) {
  const settle =
    shown !== undefined &&
    "motion-safe:animate-[line-in_420ms_var(--ease-settle)_both]";
  let row = -1;
  return thread.lines.map((line, index) => {
    const hidden = shown !== undefined && index >= shown;
    if ("moment" in line)
      return (
        <p
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are authored and fixed.
          key={index}
          hidden={hidden}
          className={cn(
            "my-6 flex items-center gap-3 text-caption text-muted before:h-px before:flex-1 before:bg-hairline after:h-px after:flex-1 after:bg-hairline first:mt-0",
            settle,
          )}
        >
          {line.moment}
        </p>
      );
    row++;
    const person = participants[line.speaker];
    const self = line.speaker === thread.perspective;
    return (
      <article
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are authored and fixed.
        key={index}
        data-message={row}
        data-speaker={line.speaker}
        data-author={person.name}
        hidden={hidden}
        className={cn(
          "mb-5 grid grid-cols-[28px_minmax(0,1fr)_28px] grid-rows-[18px_auto] items-start gap-x-2 gap-y-1.5 last:mb-0 md:grid-cols-[32px_minmax(0,1fr)_32px] md:gap-x-2.5",
          settle,
        )}
      >
        <span
          className={cn(
            "row-start-2 block size-7 overflow-hidden rounded-full bg-note md:size-8",
            self ? "col-start-3" : "col-start-1",
          )}
        >
          <Picture
            picture={avatars[line.speaker]}
            alt=""
            sizes="32px"
            className="size-full"
            lazy={false}
          />
        </span>
        <p
          className={cn(
            "col-start-2 row-start-1 flex min-w-0 gap-2 px-3 text-xs leading-[18px] text-muted",
            self && "justify-end",
          )}
        >
          <span>{person.name}</span>
          <span>{"badge" in person ? person.badge : person.role}</span>
        </p>
        <div
          data-chat-bubble
          className={cn(
            "col-start-2 row-start-2 min-w-0 max-w-full [&_li]:[text-wrap:wrap] [&_p]:[text-wrap:wrap] px-3 py-2 text-[14px] leading-[23px] md:px-3.5 md:py-2.5 md:text-[15px] md:leading-[25px]",
            self
              ? "justify-self-end rounded-[12px_4px_12px_12px] bg-control"
              : "justify-self-start rounded-[4px_12px_12px_12px] bg-note",
          )}
        >
          <IntroductionMarkdown
            content={line.text}
            typing={typing && line.speaker === "mochi"}
            inspect={inspect}
          />
        </div>
      </article>
    );
  });
}

/** A source opened from an answer: the example record, never a real repository. */
export function useEvidence(onToggle?: (open: boolean) => void) {
  const dialog = useRef<HTMLDialogElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const [id, setId] = useState<string | null>(null);
  const inspect = useCallback(
    (next: string, from: HTMLAnchorElement) => {
      origin.current = from;
      setId(next);
      onToggle?.(true);
    },
    [onToggle],
  );
  useEffect(() => {
    if (id && !dialog.current?.open) dialog.current?.showModal();
  }, [id]);
  const item = id ? evidence[id] : undefined;
  const view = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively; the click only catches its backdrop.
    <dialog
      ref={dialog}
      aria-labelledby="evidence-title"
      onClose={() => {
        setId(null);
        onToggle?.(false);
        origin.current?.focus();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      className="m-auto max-h-[min(640px,calc(100dvh-48px))] w-[min(540px,calc(100vw-32px))] overflow-hidden rounded-card border-0 bg-surface p-0 text-ink shadow-card"
    >
      {item && (
        <div className="max-h-[inherit] overflow-y-auto px-7 pt-6 pb-7">
          <div className="mb-5 flex items-center justify-between text-caption text-muted">
            <span>GitHub · 示例资料</span>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => dialog.current?.close()}
              className="-mr-2 flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-ink/5 hover:text-ink"
            >
              <Glyph name="close" size={16} />
            </button>
          </div>
          <h3 id="evidence-title" className="text-[20px] leading-7 font-medium">
            {item.title}
          </h3>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-caption text-muted">
            <span>{item.moment}</span>
            <span className="rounded-full bg-note px-2 py-0.5">
              {item.state}
            </span>
          </p>
          <ul className="mt-5 list-disc space-y-2 pl-5 text-[15px] leading-[25px] marker:text-muted">
            {item.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          {"note" in item && item.note && (
            <p className="mt-5 border-t border-hairline pt-4 text-caption text-muted">
              {item.note}
            </p>
          )}
        </div>
      )}
    </dialog>
  );
  return { inspect, view };
}

export type Playback = "none" | "in-view";

/**
 * One thread with optional playback. Server and first client render show the
 * whole transcript; playback then takes over with the companion's own rhythm.
 * Reading (scroll, touch, keys) reveals everything at once, as in the app.
 */
export function Conversation({
  thread,
  playback,
  scroll = false,
  className,
  children,
}: {
  thread: Thread;
  playback: Playback;
  /** A fixed-height panel scrolls its own history. */
  scroll?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const history = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLParagraphElement>(null);
  const controller = useRef<Controller | null>(null);
  const [typing, setTyping] = useState(false);
  const { inspect, view } = useEvidence(
    useCallback((open: boolean) => controller.current?.pause(open), []),
  );

  useEffect(() => {
    const node = history.current!;
    if (
      playback === "none" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      node.dataset.playbackReady = "";
    else setTyping(true);
  }, [playback]);

  useLayoutEffect(() => {
    if (!typing) return;
    const node = history.current!;
    if (!scroll) node.style.minHeight = `${node.offsetHeight}px`;
    const announce = (text: string) => {
      if (live.current) live.current.textContent = text;
    };
    const playing = introductionPlayback(node, () => {}, announce);
    controller.current = playing;
    node.dataset.playbackReady = "";
    let observer: IntersectionObserver | undefined;
    if (playback === "in-view") {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          observer?.disconnect();
          playing.start();
        },
        { threshold: 0.35 },
      );
      observer.observe(node);
    }
    return () => {
      observer?.disconnect();
      playing.dispose();
      controller.current = null;
    };
  }, [typing, playback, scroll]);

  // Only a panel that scrolls its own history can be taken over by reading;
  // elsewhere the wheel belongs to the page.
  const read = () => {
    if (scroll) controller.current?.read();
  };
  return (
    <div className={className}>
      {children}
      <div
        ref={history}
        data-playback={playback === "none" ? undefined : ""}
        tabIndex={scroll ? 0 : undefined}
        aria-label={`对话示例：${thread.title}`}
        role="log"
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
        className={cn(
          "relative",
          scroll &&
            "min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] [mask-image:linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%-20px),transparent)] py-3",
        )}
      >
        <Transcript thread={thread} typing={typing} inspect={inspect} />
      </div>
      <p ref={live} aria-live="polite" className="sr-only" />
      {view}
    </div>
  );
}
