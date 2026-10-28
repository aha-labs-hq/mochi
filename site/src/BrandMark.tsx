import apple from "./brand/apple.svg";
import github from "./brand/github.svg";

const marks = { apple, github };

/** The adjacent link text names the destination; the mark is decorative. */
export function BrandMark({
  name,
  className,
}: {
  name: keyof typeof marks;
  className?: string;
}) {
  return (
    <img
      src={marks[name]}
      alt=""
      width={18}
      height={18}
      className={className}
    />
  );
}
