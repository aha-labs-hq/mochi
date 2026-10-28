import { useEffect, useRef } from "react";
import { Button } from "./Controls.tsx";

/** The performance is the invitation. No dialog, launcher or fake desktop. */
export function Encounter({
  skip,
  available,
}: {
  skip(): void;
  available: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Native menu activation can leave first responder outside the WebView.
    // The new scene owns keyboard focus, including its advertised Escape action.
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const skipOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", skipOnEscape);
    return () => window.removeEventListener("keydown", skipOnEscape);
  }, [skip]);
  return (
    <section
      data-testid="encounter"
      className="pointer-events-none absolute inset-0 z-3"
    >
      <h1 ref={heading} tabIndex={-1} className="sr-only">
        麻薯来到你的桌面
      </h1>
      {!available && (
        <p
          role="alert"
          className="absolute inset-x-0 top-1/2 text-center text-sm text-white [text-shadow:0_1px_8px_#000]"
        >
          出场动效尚未准备好，可以直接开始设置。
        </p>
      )}
      <div className="pointer-events-auto absolute top-10 right-10">
        <Button
          className="rounded-full border-white/20 bg-scrim/60 px-4 py-2 text-xs font-medium text-white backdrop-blur-lg hover:bg-scrim/80"
          onClick={skip}
        >
          跳过开场{" "}
          <span aria-hidden className="ml-2 opacity-60">
            esc
          </span>
        </Button>
      </div>
    </section>
  );
}
