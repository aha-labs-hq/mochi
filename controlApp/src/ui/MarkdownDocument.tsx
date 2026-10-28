import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { BUILTIN_SKILLS, type SkillId } from "../shared/bridge.ts";
import { cn } from "./styles.ts";

/** Reading typography only. No schema extraction, HTML execution or remote embeds. */
export function MarkdownDocument({
  content,
  navigate,
}: {
  content: string;
  navigate(id: SkillId): void;
}) {
  const components: Components = {
    h1: ({ children, id }) => (
      <h1
        tabIndex={-1}
        id={id}
        className="mt-8 mb-5 text-title leading-snug font-semibold tracking-[-.03em] first:mt-0 outline-none"
      >
        {children}
      </h1>
    ),
    h2: ({ children, id }) => (
      <h2
        id={id}
        className="mt-8 mb-3 text-xl leading-snug font-semibold tracking-[-.02em] first:mt-0"
      >
        {children}
      </h2>
    ),
    h3: ({ children, id }) => (
      <h3
        id={id}
        className="mt-6 mb-3 text-base leading-snug font-semibold first:mt-0"
      >
        {children}
      </h3>
    ),
    h4: ({ children, id }) => (
      <h4 id={id} className="mt-5 mb-2 font-semibold">
        {children}
      </h4>
    ),
    h5: ({ children, id }) => (
      <h5 id={id} className="mt-5 mb-2 font-semibold">
        {children}
      </h5>
    ),
    h6: ({ children, id }) => (
      <h6 id={id} className="mt-5 mb-2 font-semibold text-muted">
        {children}
      </h6>
    ),
    p: ({ children, id }) => (
      <p id={id} className="my-3 first:mt-0 last:mb-0">
        {children}
      </p>
    ),
    ul: ({ children }) => (
      <ul className="my-4 list-disc space-y-2 pl-5 marker:text-muted">
        {children}
      </ul>
    ),
    ol: ({ children, start }) => (
      <ol
        start={start}
        className="my-4 list-decimal space-y-2 pl-5 marker:text-muted"
      >
        {children}
      </ol>
    ),
    li: ({ children, id }) => (
      <li id={id} className="pl-1 [&>p]:my-2 [&>ul]:my-2 [&>ol]:my-2">
        {children}
      </li>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-5 border-l-2 border-hairline pl-4 text-muted">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-7 border-hairline" />,
    pre: ({ children }) => (
      <pre className="my-5 max-w-full overflow-x-auto overscroll-contain rounded-xl border border-hairline bg-control px-4 py-3 text-xs leading-relaxed [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0">
        {children}
      </pre>
    ),
    code: ({ children }) => (
      <code className="rounded bg-note px-1 py-0.5 font-mono text-[.88em]">
        {children}
      </code>
    ),
    table: ({ children }) => (
      <div className="my-5 max-w-full overflow-x-auto overscroll-contain rounded-lg border border-hairline">
        <table className="w-full border-collapse text-left text-sm">
          {children}
        </table>
      </div>
    ),
    th: ({ children, style }) => (
      <th
        className={cn(
          "border-b border-hairline bg-control px-3 py-2 font-semibold",
          style?.textAlign === "right" && "text-right",
          style?.textAlign === "center" && "text-center",
        )}
      >
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td
        className={cn(
          "border-b border-hairline px-3 py-2",
          style?.textAlign === "right" && "text-right",
          style?.textAlign === "center" && "text-center",
        )}
      >
        {children}
      </td>
    ),
    a: ({ children, href, id, ...props }) => {
      const skill = BUILTIN_SKILLS.find(
        (item) => href === `${item.id}.md` || href === `./${item.id}.md`,
      );
      if (skill)
        return (
          <button
            type="button"
            className="cursor-pointer text-primary underline decoration-primary/35 underline-offset-3 focus-visible:rounded control-focus"
            data-route-focus={`method-link-${skill.id}`}
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              navigate(skill.id);
            }}
          >
            {children}
          </button>
        );
      if (href?.startsWith("#"))
        return (
          <a
            id={id}
            href={href}
            aria-label={props["aria-label"]}
            className="text-primary underline underline-offset-3"
            onClick={(event) => {
              event.preventDefault();
              document
                .getElementById(href.slice(1))
                ?.scrollIntoView({ block: "nearest" });
            }}
          >
            {children}
          </a>
        );
      return (
        <span>
          {children}
          {href && (
            <span className="ml-1 break-all text-[.9em] text-muted">
              （{href}）
            </span>
          )}
        </span>
      );
    },
    img: ({ alt, src }) => (
      <span className="my-3 block rounded-lg border border-hairline px-3 py-2 text-muted">
        图片：{alt || "未命名图片"}
        {src && <span className="mt-1 block break-all text-xs">{src}</span>}
      </span>
    ),
  };
  return (
    <div className="min-w-0 select-text text-base leading-[1.85] break-words text-ink/85 selection:bg-primary/20">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
