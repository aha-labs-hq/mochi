import type { CSSProperties, ReactNode } from "react";
import { Glyph, type GlyphName } from "../../controlApp/src/ui/Glyph.tsx";
import { cn } from "../../controlApp/src/ui/styles.ts";
import type { Picture as PictureData } from "../build/pictures.ts";
import { useSite } from "./context.ts";
import { betaApplicationUrl } from "./facts.ts";

export { cn, Glyph };

export function Picture({
  picture,
  alt,
  sizes,
  className,
  priority = false,
  lazy = !priority,
}: {
  picture: PictureData;
  alt: string;
  sizes: string;
  className?: string;
  /** Above the fold: fetch first. */
  priority?: boolean;
  /** Small images inside revealed content load with it, not on scroll. */
  lazy?: boolean;
}) {
  return (
    <picture>
      <source type="image/avif" srcSet={picture.avif} sizes={sizes} />
      <source type="image/webp" srcSet={picture.webp} sizes={sizes} />
      <img
        src={picture.src}
        width={picture.width}
        height={picture.height}
        alt={alt}
        loading={lazy ? "lazy" : "eager"}
        decoding="async"
        fetchPriority={priority ? "high" : undefined}
        className={className}
      />
    </picture>
  );
}

/** The one primary action: solid, with an arrow that says where it leads. */
export function Action({
  href,
  children,
  glyph = "arrowRight",
  className,
}: {
  href: string;
  children: ReactNode;
  glyph?: GlyphName;
  className?: string;
}) {
  return (
    <a
      href={href}
      data-analytics-event={
        href === betaApplicationUrl ? "beta_form_open" : undefined
      }
      className={cn(
        "group inline-flex h-12 items-center gap-3 rounded-xl bg-primary pr-4 pl-5 text-[15px] font-medium text-on-primary shadow-[0_1px_2px_#0000001f,inset_0_1px_0_#ffffff26] transition-[filter,translate] duration-200 hover:brightness-110 active:translate-y-px",
        className,
      )}
    >
      {children}
      <Glyph
        name={glyph}
        size={18}
        className="transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
      />
    </a>
  );
}

/** All product entry points use the download page's actual release phase. */
export function DownloadAction() {
  const { release } = useSite();
  return (
    <Action href="/download/">{release ? "下载 Mochi" : "申请内测"}</Action>
  );
}

/** A quiet text route, for the second choice beside an Action. */
export function Route({
  href,
  children,
  glyph = "arrowRight",
  className,
}: {
  href: string;
  children: ReactNode;
  glyph?: GlyphName;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={cn(
        "group inline-flex h-12 items-center gap-2 px-1 text-[15px] font-medium text-ink transition-colors hover:text-primary",
        className,
      )}
    >
      {children}
      <Glyph
        name={glyph}
        size={16}
        className={cn(
          "text-muted transition-[color,translate] duration-200 group-hover:text-primary motion-reduce:transition-none",
          glyph === "arrowDown"
            ? "group-hover:translate-y-0.5"
            : "group-hover:translate-x-0.5",
        )}
      />
    </a>
  );
}

/**
 * Chinese has no spaces to break at, and Safari cannot find phrases itself.
 * `|` marks where a line may break; each phrase otherwise stays whole.
 */
export function Phrases({ text }: { text: string }) {
  return text.split("|").map((phrase) => (
    <span key={phrase} className="inline-block">
      {phrase}
    </span>
  ));
}

export function Section({
  id,
  className,
  children,
  labelledBy,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
  labelledBy?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn("site-section py-20 md:py-28", className)}
    >
      <div className="site-container">{children}</div>
    </section>
  );
}

/** Content that settles into place once as the reader reaches it. */
export function reveal(delay = 0) {
  return {
    "data-reveal": "",
    style: { "--reveal-delay": `${delay}ms` } as CSSProperties,
  };
}
