import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { PENDING, PENDING_LINK } from "./context.ts";

/* Public documents link to each other by their published file names. */
const routes: Record<string, string> = {
  "README.md": "/start/",
  "PRIVACY.md": "/privacy/",
};

const components: Components = {
  h1: ({ children }) => <h1 className="phrase section-title">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="mt-14 mb-4 text-title font-semibold">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-8 mb-3 text-[17px] leading-7 font-semibold">
      {children}
    </h3>
  ),
  p: ({ children }) => <p className="my-4">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-4 list-disc space-y-2 pl-5 marker:text-muted">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-4 list-decimal space-y-2 pl-5 marker:text-muted">
      {children}
    </ol>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  code: ({ children }) => (
    <code className="rounded-md bg-note px-1.5 py-0.5 font-mono text-[0.9em]">
      {children}
    </code>
  ),
  a: ({ href, children }) => {
    if (href === PENDING_LINK)
      return (
        <span className="text-muted">
          {children}（{PENDING}）
        </span>
      );
    return (
      <a
        href={routes[href ?? ""] ?? href}
        className="text-primary underline-offset-4 hover:underline"
      >
        {children}
      </a>
    );
  },
};

/** Long-form reading for the published user documents. */
export function Prose({ markdown }: { markdown: string }) {
  return (
    <div className="text-base leading-[1.9] [&>h1:first-child]:mb-8">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
