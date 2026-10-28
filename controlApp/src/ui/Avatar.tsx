import { type ReactNode, useState } from "react";
import { cn } from "./styles.ts";

/** A decorative image beside its visible name. A failed image keeps the same footprint. */
export function Avatar({
  src,
  small = false,
  placeholder,
}: {
  src: string | null;
  small?: boolean;
  placeholder: ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/15 text-muted ring-1 ring-inset ring-hairline",
        small ? "size-6 rounded-sm text-xs ring-inverse/20" : "size-10 text-lg",
      )}
    >
      {src ? (
        <AvatarImage key={src} src={src} placeholder={placeholder} />
      ) : (
        placeholder
      )}
    </span>
  );
}

function AvatarImage({
  src,
  placeholder,
}: {
  src: string;
  placeholder: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    placeholder
  ) : (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      className="size-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}
