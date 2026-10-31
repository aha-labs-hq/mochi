import continuity from "../assets/editorial/continuity.webp?w=480,768,1360&picture";
import sharedContext from "../assets/editorial/shared-context.webp?w=480,768,1360&picture";
import { Shell } from "../layout.tsx";
import { Prose } from "../prose.tsx";
import { superagentArticle, superagentSections } from "../superagent.ts";
import { Picture } from "../ui.tsx";

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
            <h1 className="section-title">
              {article.headingPhrases.map((phrase) => (
                <span key={phrase} className="inline-block max-w-full">
                  {phrase}
                </span>
              ))}
            </h1>
            <p className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-small text-muted">
              <a
                href={article.author.url}
                rel="author"
                className="hover:text-primary"
              >
                {article.author.name}
              </a>
              <time dateTime={article.datePublished}>
                {article.datePublished.replaceAll("-", ".")}
              </time>
            </p>
          </header>
          <figure className="mb-10">
            <Picture
              picture={sharedContext}
              alt={article.image.alt}
              sizes="(min-width: 768px) 680px, calc(100vw - 40px)"
              priority
              className="h-auto w-full rounded-xl"
            />
            <figcaption className="mt-3 text-caption text-muted">
              讨论、决定和进展，留在同一份上下文里。
            </figcaption>
          </figure>
          <div className="[&_blockquote]:my-6 [&_blockquote]:border-l-2 [&_blockquote]:border-ink/15 [&_blockquote]:pl-5 [&_blockquote]:text-muted [&_code]:break-all">
            <Prose markdown={superagentSections[0]} />
            <figure className="my-10">
              <Picture
                picture={continuity}
                alt="一根蓝色线将聊天气泡、确认标记和项目册连起来，麻薯守在册子旁"
                sizes="(min-width: 768px) 680px, calc(100vw - 40px)"
                className="h-auto w-full rounded-xl"
              />
              <figcaption className="mt-3 text-caption text-muted">
                换一个同事来问，也能接着往下走。
              </figcaption>
            </figure>
            <Prose markdown={superagentSections[1]} />
          </div>
        </div>
      </article>
    </Shell>
  );
}
