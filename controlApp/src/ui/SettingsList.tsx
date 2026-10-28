import type { ComponentProps, ReactNode } from "react";
import { cn } from "./styles.ts";

/**
 * One surface for a group of peer objects. It is the only container a
 * settings page draws inside the reading panel; sections are grouped by
 * space and shared axes, never by a second frame.
 */
export function SettingsList({
  label,
  scroll = false,
  className,
  children,
}: {
  label?: string;
  /** Long resource lists scroll inside the surface, never the page width. */
  scroll?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "list-none overflow-hidden rounded-md border border-hairline bg-card",
        scroll &&
          "settings-scrollbar max-h-[264px] overflow-y-auto overscroll-contain",
        className,
      )}
    >
      {children}
    </ul>
  );
}

/**
 * Leading image, words and trailing control share three tracks in every list.
 * The divider starts at the words, so the image column reads as one line.
 */
export function SettingsRow({
  leading,
  title,
  detail,
  trailing,
  feedback,
  action,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  /** A failure or confirmation that belongs to this row, under its words. */
  feedback?: ReactNode;
  /** Makes the whole row one navigation target. */
  action?: ComponentProps<"button"> & {
    [data: `data-${string}`]: string | undefined;
  };
  className?: string;
}) {
  const body = (
    <>
      {leading}
      <span className="flex min-h-16 min-w-0 flex-1 items-center gap-4 border-t border-hairline py-3 pr-4 group-first/row:border-t-0">
        <span className="block min-w-0 flex-1">
          <span className="block text-sm leading-5 font-medium [overflow-wrap:anywhere]">
            {title}
          </span>
          {detail && (
            <span className="mt-0.5 block text-xs leading-5 text-muted [overflow-wrap:anywhere]">
              {detail}
            </span>
          )}
        </span>
        {trailing}
      </span>
    </>
  );
  return (
    <li className={cn("group/row", className)}>
      {action ? (
        <button
          type="button"
          {...action}
          className={cn(
            "flex w-full cursor-pointer items-center gap-4 pl-4 text-left transition-colors duration-150 hover:bg-ink/3 motion-reduce:transition-none control-focus",
            action.className,
          )}
        >
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-4 pl-4">{body}</div>
      )}
      {feedback && (
        <div className={cn("pr-4 pb-3", leading ? "pl-18" : "pl-4")}>
          {feedback}
        </div>
      )}
    </li>
  );
}
