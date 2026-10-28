import { faq } from "../faq.ts";
import { Shell } from "../layout.tsx";
import { Prose } from "../prose.tsx";
import { DownloadAction } from "../ui.tsx";

const markdown = `# Mochi 常见问题

关于数据、权限、设备、模型费用和支持范围的直接回答。更细的说明见[上手指南](/start/)、[隐私说明](/privacy/)和[给管理员的说明](/admin/)。

${faq.map(([question, answer]) => `## ${question}\n\n${answer}`).join("\n\n")}`;

/** Every question on one readable, indexable page; the home page shows the first ones. */
export function Faq() {
  return (
    <Shell>
      <article className="site-container py-16 md:py-24">
        <div className="mx-auto max-w-[680px]">
          <Prose markdown={markdown} />
          <section className="mt-14 pt-8">
            <h2 className="mb-4 text-title font-semibold">
              还想先看看它怎么工作
            </h2>
            <p className="mb-6 text-muted">
              每篇实际用法都从一个场景出发，说明怎么开始和它做不到什么。
            </p>
            <DownloadAction />
            <p className="mt-6">
              <a
                className="text-primary underline underline-offset-4"
                href="/workflows/"
              >
                看看实际用法
              </a>
            </p>
          </section>
        </div>
      </article>
    </Shell>
  );
}
