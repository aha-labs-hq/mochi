import type { ReactNode } from "react";
import { cn } from "./styles.ts";

/**
 * Every section opens on a hairline rule across the reading column, with its
 * title, count or action and one line of context directly beneath. The rule
 * marks where a group starts; proximity holds the group together.
 */
export function SettingsSectionHeader({
  id,
  title,
  description,
  actions,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="settings-grid mb-4 items-center gap-y-1 border-t border-hairline pt-3">
      <h2
        id={id}
        className={cn(
          "settings-section-title flex min-h-8 min-w-0 items-center [overflow-wrap:anywhere]",
          actions
            ? "col-span-4 @max-[560px]/settings:col-span-3"
            : "col-span-6",
        )}
      >
        {title}
      </h2>
      {actions && (
        <div className="col-span-2 flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs leading-5 text-muted @max-[560px]/settings:col-span-3">
          {actions}
        </div>
      )}
      {description && (
        <div className="settings-note col-span-6">{description}</div>
      )}
    </header>
  );
}
