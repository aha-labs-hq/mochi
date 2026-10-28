import type { ReactNode } from "react";
import governance from "../../.github/governance.json";
import ring from "./brand/aha-labs-ring.svg";
import { PENDING, supportText, useSite } from "./context.ts";
import { maker, tagline } from "./facts.ts";
import { art } from "./media.ts";
import { cn, Picture } from "./ui.tsx";

const repositoryUrl = `https://github.com/${governance.repository.slug}`;

function Wordmark({ priority = false }: { priority?: boolean }) {
  return (
    <a
      href="/"
      className="flex items-center gap-2.5 rounded-lg"
      aria-label="Mochi 首页"
    >
      <Picture
        picture={art.appIcon}
        alt=""
        sizes="28px"
        className="size-7 rounded-[7px]"
        priority={priority}
      />
      <span className="font-brand text-[19px] leading-none font-semibold tracking-[-0.01em]">
        Mochi
      </span>
    </a>
  );
}

/** The places every page leads to; phones reach them through one menu. */
const navigation = [
  ["能做什么", "/#roles"],
  ["安全", "/#trust"],
  ["上手指南", "/start/"],
  ["管理员说明", "/admin/"],
  ["GitHub", repositoryUrl],
] as const;

function Header() {
  const { release } = useSite();
  return (
    <header
      data-header
      className="sticky top-0 z-30 bg-surface/92 backdrop-blur-xl backdrop-saturate-150 transition-[background-color,border-color] duration-300"
    >
      <div className="site-container flex h-16 items-center justify-between gap-4">
        <Wordmark priority />
        <nav aria-label="主导航" className="relative flex items-center gap-1">
          {navigation.map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="hidden h-9 items-center rounded-lg px-3 text-small text-muted transition-colors hover:text-ink md:inline-flex"
            >
              {label}
            </a>
          ))}
          <details data-menu className="group md:hidden">
            <summary
              data-menu-toggle
              className="flex size-10 cursor-pointer list-none items-center justify-center rounded-lg text-ink transition-colors group-open:bg-note [&::-webkit-details-marker]:hidden"
            >
              <span className="sr-only">菜单</span>
              <svg
                viewBox="0 0 20 20"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M3.5 7h13M3.5 13h13" className="group-open:hidden" />
                <path
                  d="M5 5l10 10M15 5L5 15"
                  className="hidden group-open:block"
                />
              </svg>
            </summary>
            <ul className="absolute top-12 right-0 w-52 rounded-xl border border-hairline bg-card p-1.5 shadow-card">
              {navigation.map(([label, href]) => (
                <li key={href}>
                  <a
                    href={href}
                    className="flex h-11 items-center rounded-lg px-3 text-[15px] transition-colors hover:bg-note"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </details>
          <a
            href="/download/"
            className="ml-2 inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-small font-medium text-on-primary transition-[filter] hover:brightness-110"
          >
            {release ? "下载 Mochi" : "申请内测"}
          </a>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  const { publication, release } = useSite();
  const groups: [string, [string, string | null][]][] = [
    [
      "产品",
      [
        ["能做什么", "/#roles"],
        ["实际用法", "/workflows/"],
        [release ? "下载 Mochi" : "申请内测", "/download/"],
        ["上手指南", "/start/"],
        ["常见问题", "/faq/"],
      ],
    ],
    [
      "安全与隐私",
      [
        ["给管理员的说明", "/admin/"],
        ["隐私说明", "/privacy/"],
      ],
    ],
    [
      "支持",
      [
        publication
          ? [supportText(publication.supportUrl), publication.supportUrl]
          : ["支持入口", null],
        ["GitHub", repositoryUrl],
      ],
    ],
  ];
  return (
    <footer className="overflow-hidden bg-card">
      <div className="site-container site-grid gap-y-12 py-16">
        <div className="col-span-4 md:col-span-5">
          <Wordmark />
          <p className="mt-4 max-w-[22em] text-small text-muted">{tagline}</p>
        </div>
        <nav
          aria-label="页脚"
          className="col-span-4 grid grid-cols-2 gap-8 sm:grid-cols-3 md:col-span-7"
        >
          {groups.map(([title, links]) => (
            <div key={title}>
              <p className="mb-3 text-caption text-muted">{title}</p>
              <ul className="space-y-2 text-small">
                {links.map(([label, href]) => (
                  <li key={label}>
                    {href ? (
                      <a
                        href={href}
                        className="transition-colors hover:text-primary"
                      >
                        {label}
                      </a>
                    ) : (
                      <span className="text-muted">
                        {label}（{PENDING}）
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="site-container flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-6 text-caption text-muted">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <a
            href={maker.url}
            className="inline-flex items-center gap-2.5 text-ink transition-colors hover:text-primary"
          >
            {/* The brand's smiling ring; 40 px is its smallest size. */}
            <img
              src={ring}
              alt=""
              width={40}
              height={40}
              loading="lazy"
              decoding="async"
              className="size-10"
            />
            {maker.name} 出品
          </a>
          {publication && (
            <span>
              © {new Date().getFullYear()} {publication.publisherName}
            </span>
          )}
        </p>
        {!publication && <p>预览版本 · 不会被搜索引擎收录</p>}
      </div>
      <div
        aria-hidden
        className="pointer-events-none -mt-[0.18em] -mb-[0.24em] text-center font-brand text-[clamp(112px,24vw,340px)] leading-none font-semibold tracking-[-0.04em] text-ink/[0.045] select-none after:content-['Mochi']"
      />
    </footer>
  );
}

export function Shell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-ink px-4 py-2 text-surface focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        跳到正文
      </a>
      <Header />
      <main id="main" tabIndex={-1} className={cn(className)}>
        {children}
      </main>
      <Footer />
    </>
  );
}
