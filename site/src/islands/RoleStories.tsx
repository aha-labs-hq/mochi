import { useRef, useState } from "react";
import { participants } from "../../../controlApp/src/ui/introductionContent.ts";
import { Conversation } from "../conversation.tsx";
import { avatars } from "../media.ts";
import { stories } from "../threads.ts";
import { cn, Picture } from "../ui.tsx";

/** What each profession stops having to do, in its own words. */
const relief: Record<string, string> = {
  product: "搁置的需求，捡起来就知道还差什么",
  operations: "发给客户之前，确认每句话都是真的",
  design: "用真实反馈给设计决定撑腰",
  engineering: "开工前，不用挨个找人问一遍",
  lead: "不开同步会，也知道谁需要接一下",
};
for (const story of stories)
  if (!relief[story.id]) throw new Error(`No relief line for ${story.id}`);

export function RoleStories({ initial }: { initial: string }) {
  const [selected, setSelected] = useState(initial);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const story = stories.find((item) => item.id === selected) ?? stories[0]!;
  const person = participants[story.perspective!];

  const move = (from: number, step: number) => {
    const next = (from + step + stories.length) % stories.length;
    setSelected(stories[next]!.id);
    tabs.current[next]?.focus();
  };

  return (
    <div className="site-grid gap-y-10">
      <div
        role="tablist"
        aria-label="选择你的职能"
        aria-orientation="vertical"
        className="col-span-4 -mx-2 grid grid-cols-5 gap-1 md:col-span-5 md:mx-0 md:flex md:flex-col md:gap-0 md:border-t md:border-hairline"
      >
        {stories.map((item, index) => {
          const active = item.id === story.id;
          return (
            <button
              key={item.id}
              ref={(node) => {
                tabs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`role-${item.id}`}
              aria-selected={active}
              aria-controls="role-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => setSelected(item.id)}
              onKeyDown={(event) => {
                if (["ArrowDown", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  move(index, 1);
                } else if (["ArrowUp", "ArrowLeft"].includes(event.key)) {
                  event.preventDefault();
                  move(index, -1);
                }
              }}
              className={cn(
                "group relative flex flex-col items-center gap-2 rounded-xl px-1 py-2 text-center transition-colors md:flex-row md:items-center md:gap-4 md:rounded-none md:border-b md:border-hairline md:px-0 md:py-4 md:text-left",
                "before:absolute before:inset-y-0 before:-left-6 before:hidden before:w-0.5 before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity md:before:block",
                active && "before:opacity-100",
              )}
            >
              <span
                className={cn(
                  "block size-12 shrink-0 overflow-hidden rounded-full ring-2 ring-offset-2 ring-offset-surface transition-[box-shadow,filter] md:size-14",
                  active
                    ? "ring-primary"
                    : "ring-transparent grayscale-[35%] group-hover:grayscale-0",
                )}
              >
                <Picture
                  picture={avatars[item.perspective!]}
                  alt=""
                  sizes="56px"
                  className="size-full"
                />
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-small font-medium transition-colors md:text-[17px] md:leading-7",
                    active ? "text-ink" : "text-muted group-hover:text-ink",
                  )}
                >
                  {item.role}
                </span>
                <span className="hidden text-small text-muted md:block">
                  {relief[item.id]}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div
        id="role-panel"
        role="tabpanel"
        aria-labelledby={`role-${story.id}`}
        className="col-span-4 md:col-span-7"
      >
        <p className="mb-4 text-small text-muted md:hidden">
          {relief[story.id]}
        </p>
        <Conversation
          key={story.id}
          thread={story}
          playback="in-view"
          scroll
          className="flex h-[560px] flex-col rounded-card bg-card px-4 pt-6 pb-3 shadow-card md:h-[700px] md:px-7 md:pt-7"
        >
          <header className="mb-1 flex items-start justify-between gap-4 border-b border-hairline pb-4">
            <div className="min-w-0">
              <p className="mb-1.5 text-caption text-muted">
                {person.name} 的视角 · 示例对话
              </p>
              <h3 className="text-[17px] leading-6 font-medium">
                {story.title}
              </h3>
            </div>
          </header>
        </Conversation>
      </div>
    </div>
  );
}
