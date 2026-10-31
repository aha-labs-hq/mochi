import { maker } from "../facts.ts";
import { Shell } from "../layout.tsx";
import { Prose } from "../prose.tsx";
import { superagentArticle, superagentMarkdown } from "../superagent.ts";

export function Insight() {
  const article = superagentArticle;
  return (
    <Shell>
      <article className="site-container py-16 md:py-24">
        <div className="mx-auto max-w-[680px]">
          <header className="mb-10">
            <p className="mb-5 text-caption text-muted">
              {article.articleSection}
            </p>
            <h1 className="phrase section-title">{article.name}</h1>
            <p className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-small text-muted">
              <a href={maker.url} rel="author" className="hover:text-primary">
                {maker.name}
              </a>
              <time dateTime={article.datePublished}>
                {article.datePublished.replaceAll("-", ".")}
              </time>
            </p>
          </header>
          <div className="[&_blockquote]:my-6 [&_blockquote]:border-l-2 [&_blockquote]:border-ink/15 [&_blockquote]:pl-5 [&_blockquote]:text-muted [&_code]:break-all">
            <Prose markdown={superagentMarkdown} />
          </div>
        </div>
      </article>
    </Shell>
  );
}
