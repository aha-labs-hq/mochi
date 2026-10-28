import { Slider } from "@base-ui/react/slider";
import { useState } from "react";
import type { RuntimeReasoningEffortOption } from "../../../src/runtime/protocol.ts";
import { effortLabel } from "../shared/vocabulary.ts";
import { cn } from "./styles.ts";

/** The app's settling curve; the thumb, fill and ticks move as one. */
const GLIDE =
  "duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

/** Catalog order defines discrete steps. This control edits the existing form draft. */
export function EffortPicker({
  options,
  value,
  disabled,
  onChange,
}: {
  options: readonly RuntimeReasoningEffortOption[];
  value: string | undefined;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const index = options.findIndex((option) => option.id === value);
  if (index < 0)
    return (
      <fieldset aria-labelledby="effort-label" className="min-w-0">
        <p className="mb-2 text-xs text-muted">请选择</p>
        <div className="flex flex-wrap gap-1">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.id)}
              className="rounded-sm bg-control px-3 py-2 text-sm hover:bg-field-active disabled:opacity-55 control-focus"
            >
              {effortLabel(option.id)}
            </button>
          ))}
        </div>
      </fieldset>
    );
  if (options.length === 1)
    return (
      <p className="py-2.5 text-sm text-muted">{effortLabel(value ?? "")}</p>
    );
  return (
    <EffortSlider
      options={options}
      index={index}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

function EffortSlider({
  options,
  index,
  disabled,
  onChange,
}: {
  options: readonly RuntimeReasoningEffortOption[];
  index: number;
  disabled: boolean;
  onChange(value: string): void;
}) {
  // Base UI measures the edge-aligned thumb after mount. Gliding starts with
  // the first step so that measurement never slides in from the left.
  const [mountedIndex] = useState(index);
  const [glides, setGlides] = useState(false);
  if (!glides && index !== mountedIndex) setGlides(true);
  const value = options[index]!.id;
  return (
    <Slider.Root
      value={index}
      min={0}
      max={options.length - 1}
      step={1}
      largeStep={1}
      thumbAlignment="edge"
      disabled={disabled}
      onValueChange={(next) => {
        const option = options[next];
        if (option) onChange(option.id);
      }}
      className="min-w-0 data-disabled:opacity-55"
    >
      <Slider.Control className="relative flex h-11 touch-none items-center select-none">
        <Slider.Track className="@container relative h-8 w-full">
          {/* One capsule clips the fill; the larger thumb stays outside it.
              The gradient spans the whole scale, never stretching with the value. */}
          <div className="pointer-events-none absolute inset-0 h-full overflow-hidden rounded-full bg-linear-to-b from-field-active to-control">
            <Slider.Indicator
              className={cn(
                "overflow-hidden",
                glides && ["transition-[width]", GLIDE],
              )}
            >
              <span className="absolute inset-y-0 left-0 w-[100cqw] bg-linear-to-r from-primary/20 via-primary/55 to-primary" />
            </Slider.Indicator>
          </div>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 inset-x-[17px] flex items-center justify-between"
          >
            {options.map((option, step) => (
              <span
                key={option.id}
                className={cn(
                  "size-1.5 rounded-full transition-colors",
                  GLIDE,
                  step < index ? "bg-on-primary/35" : "bg-muted/25",
                )}
              />
            ))}
          </span>
          <Slider.Thumb
            aria-labelledby="effort-label"
            aria-valuetext={effortLabel(value)}
            className={cn(
              "size-10 rounded-full border border-hairline/50 bg-card bg-linear-to-b from-card to-field shadow-control has-focus-visible:focus-ring",
              glides && ["transition-[inset-inline-start]", GLIDE],
            )}
          />
        </Slider.Track>
      </Slider.Control>
      <Slider.Value
        aria-hidden
        className="block pt-1 text-right text-xs font-medium text-ink"
      >
        {() => effortLabel(value)}
      </Slider.Value>
    </Slider.Root>
  );
}
