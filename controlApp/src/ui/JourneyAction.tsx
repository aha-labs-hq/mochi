import type { ComponentProps } from "react";
import { Button } from "./Controls.tsx";
import { Glyph } from "./Glyph.tsx";
import { cn } from "./styles.ts";

/** The same quiet, full-row invitation used by the introduction. */
export function JourneyAction({
  children,
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      {...props}
      variant="text"
      className={cn(
        "group/journey-action m-0 inline-flex min-h-11 w-full items-center justify-between gap-6 rounded-none px-0 py-1 text-left text-base text-action enabled:active:brightness-100",
        className,
      )}
    >
      <span>{children}</span>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-action-soft transition-colors duration-150 group-disabled/journey-action:bg-control group-enabled/journey-action:group-hover/journey-action:bg-action group-enabled/journey-action:group-hover/journey-action:text-on-primary motion-reduce:transition-none">
        <Glyph name="arrowRight" size={16} />
      </span>
    </Button>
  );
}
