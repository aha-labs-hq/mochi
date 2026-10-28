import type { ReactNode } from "react";
import { useSite } from "../context.ts";
import { Shell } from "../layout.tsx";
import { Prose } from "../prose.tsx";

function DocumentPage({
  markdown,
  notice,
}: {
  markdown: string;
  notice?: ReactNode;
}) {
  return (
    <Shell>
      <article className="site-container py-16 md:py-24">
        <div className="mx-auto max-w-[680px]">
          {notice}
          <Prose markdown={markdown} />
        </div>
      </article>
    </Shell>
  );
}

/** Until a release is accepted, the guide's first step has nothing to download. */
export function Guide() {
  const { documents, release } = useSite();
  return (
    <DocumentPage
      markdown={documents.guide}
      notice={
        !release && (
          <p className="mb-10 rounded-card bg-note px-6 py-5 text-[15px] leading-[26px]">
            Mochi 正在内测，还没有公开下载。
            <a
              href="/download/"
              className="text-primary underline underline-offset-4"
            >
              申请内测
            </a>
            通过后，我们会通过你留下的联系方式把安装包发给你；下面的步骤从拿到安装包开始。
          </p>
        )
      }
    />
  );
}

export function Privacy() {
  return <DocumentPage markdown={useSite().documents.privacy} />;
}
