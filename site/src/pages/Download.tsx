import backdrop from "../../../installer/Resources/MochiDiskImageBackground.png?w=768,1200,1536&picture";
import { useSite } from "../context.ts";
import { ReleaseDownload, ReleaseFiles } from "../downloads.tsx";
import { betaApplicationUrl, needs, releaseName } from "../facts.ts";
import { Shell } from "../layout.tsx";
import { Action, Picture, Route } from "../ui.tsx";

/**
 * Only accepted release facts enable downloads; other builds invite teams
 * into the beta through its application form.
 */
export function Download() {
  const { release } = useSite();
  return (
    <Shell>
      <section className="site-container site-grid gap-y-12 py-16 md:py-24">
        <div className="col-span-4 md:col-span-10 lg:col-span-5">
          <p className="mb-6 inline-flex items-center gap-1.5 text-small font-medium">
            <span
              className="size-1.5 rounded-full bg-status-good"
              aria-hidden
            />
            {release ? releaseName(release) : "内测中"}
          </p>
          <h1 className="phrase section-title">
            {release ? "下载 Mochi" : "申请内测"}
          </h1>
          <p className="mt-6 text-lead text-muted">
            {release
              ? "下载到 Mac，接上你们的飞书与 GitHub。让麻薯从同一份项目全貌里，接住群里的问题和工作。"
              : "正式版发布之前，我们先和少量团队一起用 Mochi，名额有限。告诉我们你们的团队和想解决的事，我们会通过你留下的联系方式和你联系。安装包完成 Apple 公证之后才会发出。"}
          </p>
          {release ? (
            <ReleaseDownload release={release} />
          ) : (
            <div className="mt-10">
              <Action href={betaApplicationUrl}>填写内测申请</Action>
            </div>
          )}
          {!release && (
            <p className="mt-4 text-small text-muted">
              称呼、联系方式和一个具体需求就够了，其余选填。
              <a href="/privacy/" className="ml-1 underline underline-offset-4">
                申请资料如何处理
              </a>
            </p>
          )}
          <div className="mt-12 rounded-card bg-note p-6 md:p-7">
            <h2 className="text-[17px] leading-7 font-semibold">
              开始之前，准备好
            </h2>
            <ul className="mt-4 space-y-3 text-[15px] leading-[25px]">
              {needs(release).map((need) => (
                <li key={need} className="flex gap-3">
                  <span
                    className="mt-[9px] size-1.5 shrink-0 rounded-full bg-primary"
                    aria-hidden
                  />
                  {need}
                </li>
              ))}
            </ul>
          </div>
          {!release && (
            <p className="mt-8 text-small text-muted">
              正式版发布后，这一页会提供安装包、适用的设备与系统，以及每个文件的校验值。
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-x-4">
            <Route href="/start/">上手指南</Route>
            <Route href="/admin/">给管理员的说明</Route>
          </div>
        </div>
        <div className="col-span-4 md:col-span-10 lg:col-span-7 lg:self-start">
          <div className="overflow-hidden rounded-card shadow-card">
            <Picture
              picture={backdrop}
              alt="草地上，麻薯抱着一台小电脑往前走"
              sizes="(min-width: 1024px) 680px, 92vw"
              className="aspect-[2/1] h-auto w-full object-cover object-bottom"
              priority
            />
          </div>
          {release && <ReleaseFiles release={release} />}
        </div>
      </section>
    </Shell>
  );
}
