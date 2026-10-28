import { Switch } from "@base-ui/react/switch";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { buttonStyles, cn } from "./styles.ts";

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonStyles>) {
  return (
    <button
      type={type}
      data-variant={variant ?? "default"}
      className={cn(buttonStyles({ variant, size }), className)}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "field-focus h-9 w-full min-w-0 rounded-md border border-field-border bg-field px-2 py-[3px] text-ink",
        className,
      )}
      {...props}
    />
  );
}

const statusTones = {
  good: "text-status-good",
  pending: "text-status-attention",
  muted: "text-muted",
  error: "text-error",
} as const;
export type StatusTone = keyof typeof statusTones;

/**
 * The one way a verified state is shown: a dot and its words in the same
 * tone. It is never a filled pill, so a status cannot be mistaken for a control.
 */
export function StatusMark({
  tone,
  children,
  className,
  ...props
}: ComponentProps<"span"> & { tone: StatusTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs leading-5 whitespace-nowrap",
        statusTones[tone],
        className,
      )}
      {...props}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

const dotTones = {
  good: "bg-status-good",
  pending: "bg-status-attention",
  muted: "bg-status-idle",
  error: "bg-error",
} as const satisfies Record<StatusTone, string>;

/** A status dot alone, for places whose words are said elsewhere. */
export function StatusDot({
  tone,
  className,
}: {
  tone: StatusTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", dotTones[tone], className)}
    />
  );
}

/** Size changes the silhouette; on/off and keyboard feedback have one owner. */
export function Toggle({
  size = "regular",
  ...props
}: Omit<
  ComponentProps<typeof Switch.Root>,
  "children" | "className" | "render" | "nativeButton"
> & { size?: "compact" | "regular" }) {
  return (
    <Switch.Root
      {...props}
      render={<button type="button" />}
      nativeButton
      className="group/toggle flex h-7 shrink-0 cursor-default items-center rounded-full data-disabled:opacity-40 control-focus"
    >
      <span
        aria-hidden
        className={cn(
          "flex items-center rounded-full bg-control-boundary p-0.5 transition-colors group-data-checked/toggle:bg-primary motion-reduce:transition-none",
          size === "compact" ? "h-4.5 w-8" : "h-6 w-[42px]",
        )}
      >
        <Switch.Thumb
          className={cn(
            "block rounded-full bg-on-primary shadow-control transition-transform motion-reduce:transition-none",
            size === "compact"
              ? "size-3.5 data-checked:translate-x-3.5"
              : "size-5 data-checked:translate-x-[18px]",
          )}
        />
      </span>
    </Switch.Root>
  );
}
