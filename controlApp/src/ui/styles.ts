import { cva } from "class-variance-authority";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...values: ClassValue[]) {
  return twMerge(clsx(values));
}

// Component variants own complete, statically discoverable Tailwind classes.
export const buttonStyles = cva(
  "inline-flex cursor-default items-center justify-center gap-1.5 rounded-md border border-hairline bg-control min-h-9 px-3 py-2 text-sm font-medium text-ink leading-[1.35] shadow-control enabled:active:brightness-[.94] disabled:opacity-[.44] outline-none",
  {
    variants: {
      variant: {
        default: "control-focus",
        primary:
          "border-primary bg-primary text-on-primary disabled:border-hairline disabled:bg-control disabled:text-muted disabled:opacity-100 disabled:shadow-none control-focus",
        icon: "inline-flex size-9 items-center justify-center border-0 bg-transparent p-0 text-muted shadow-none transition-colors duration-150 enabled:hover:bg-ink/5 enabled:hover:text-ink motion-reduce:transition-none control-focus",
        duty: "inline-flex items-center gap-2 whitespace-nowrap border-0 bg-control px-4 py-2.5 text-sm font-medium text-primary shadow-none disabled:text-ink compact:px-3 compact:py-[9px] [&>span]:text-subheading [&>span]:leading-none control-focus",
        /** An unavailable action is neutral, never a paler blue. */
        text: "mt-2.5 border-0 bg-transparent shadow-none disabled:text-ink control-focus",
      },
      /** Settings rows and section headers use the small step; forms keep the regular one. */
      size: {
        regular: "",
        small: "min-h-8 px-2.5 py-1.5 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "regular" },
  },
);

export const inlineError =
  "mb-[18px] select-text text-sm leading-[1.6] text-error";
