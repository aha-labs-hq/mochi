import { Children, type ReactNode, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";

const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** A mention and its name never part across lines: "@" stays with "麻薯". */
const MENTION = /(@[^\s，,。：:！!？?、]+)/u;

function typed(text: string, typing: boolean): ReactNode {
  if (!typing) return text;
  return Array.from(segmenter.segment(text), ({ segment, index }) => (
    <span key={index} data-glyph className="opacity-0">
      {segment}
    </span>
  ));
}

function glyphs(children: ReactNode, typing: boolean) {
  return Children.map(children, (child) =>
    typeof child === "string"
      ? child.split(MENTION).map((part, index) =>
          index % 2 === 1 ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: Split order is the identity of a static message fragment.
            <span key={index} className="whitespace-nowrap">
              {typed(part, typing)}
            </span>
          ) : (
            typed(part, typing)
          ),
        )
      : child,
  );
}

/** The same Markdown message owns its links and text throughout playback. */
export function IntroductionMarkdown({
  content,
  typing,
  inspect,
}: {
  content: string;
  typing: boolean;
  inspect(id: string, origin: HTMLAnchorElement): void;
}) {
  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => (
        <p className="mb-2 last:mb-0">{glyphs(children, typing)}</p>
      ),
      ul: ({ children }) => (
        <ul className="my-1 list-disc pl-[18px] last:mb-0">{children}</ul>
      ),
      li: ({ children }) => (
        <li className="my-0.5">{glyphs(children, typing)}</li>
      ),
      strong: ({ children }) => (
        <strong className="font-medium">{glyphs(children, typing)}</strong>
      ),
      a: ({ href, children }) => (
        <a
          href={href}
          title="查看示例中的 GitHub 记录"
          className="text-action hover:underline focus-visible:rounded-sm control-focus"
          onClick={(event) => {
            event.preventDefault();
            if (href?.startsWith("#"))
              inspect(href.slice(1), event.currentTarget);
          }}
        >
          {glyphs(children, typing)}
        </a>
      ),
    }),
    [typing, inspect],
  );
  return (
    <div data-story-markdown className="select-text [overflow-wrap:anywhere]">
      <Markdown components={components}>{content}</Markdown>
    </div>
  );
}
