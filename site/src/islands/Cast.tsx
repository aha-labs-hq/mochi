import { useEffect, useRef, useState } from "react";
import type { Picture as PictureData } from "../../build/pictures.ts";
import { art } from "../media.ts";
import { cn, Picture } from "../ui.tsx";
import { Clip, prefersStillness, type videos } from "../video.tsx";

const members: {
  id: string;
  name: string;
  animal: string;
  picture: PictureData;
  /** The companion's own idle gesture; Kiwi has no approved motion yet. */
  clip?: keyof typeof videos;
}[] = [
  {
    id: "mochi",
    name: "麻薯",
    animal: "小白猫",
    picture: art.mochi,
    clip: "pet",
  },
  {
    id: "awawa",
    name: "Awawa",
    animal: "岩蹄兔",
    picture: art.awawa,
    clip: "awawa",
  },
  { id: "kiwi", name: "Kiwi", animal: "几维鸟", picture: art.kiwi },
];

function Member({
  member,
  below,
  motion,
}: {
  member: (typeof members)[number];
  /** Share of the canvas under the body's cut: it hangs below the shelf. */
  below: number;
  motion: boolean;
}) {
  const clip = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const live = motion && member.clip;
  const play = () => {
    const node = clip.current;
    if (!node || playing) return;
    node.currentTime = 0;
    void node.play().catch(() => setPlaying(false));
  };
  return (
    <li className="flex flex-col items-center">
      {/* A percentage margin follows the item's width, which this square
          canvas shares: the body's cut lands exactly on the shelf. */}
      <div
        className="relative w-full"
        style={{ marginBottom: `${-below * 100}%` }}
      >
        <Picture
          picture={member.picture}
          alt={`${member.name}，${member.animal}`}
          sizes="(min-width: 1024px) 190px, 30vw"
          className={cn("h-auto w-full", playing && "invisible")}
        />
        {live && (
          <>
            <Clip
              name={member.clip!}
              ref={clip}
              preload="none"
              onPlaying={() => setPlaying(true)}
              onEnded={() => setPlaying(false)}
              className={cn(
                "absolute inset-0 h-auto w-full",
                !playing && "opacity-0",
              )}
            />
            <button
              type="button"
              aria-label={`摸摸${member.name}`}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") play();
              }}
              onFocus={() => clip.current?.load()}
              onClick={play}
              className="absolute inset-[18%_8%_8%] cursor-grab rounded-[40%] active:cursor-grabbing"
            />
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The companions on one shelf, their bodies cut on the same line. Those with
 * approved motion respond to a stroke with their own idle gesture.
 */
export function Cast({ shelf }: { shelf: Record<string, { below: number }> }) {
  const [motion, setMotion] = useState(false);
  useEffect(() => setMotion(!prefersStillness()), []);
  return (
    <div>
      <ul className="grid grid-cols-3 items-end gap-4 border-b border-ink/20">
        {members.map((member) => (
          <Member
            key={member.id}
            member={member}
            below={shelf[member.id]!.below}
            motion={motion}
          />
        ))}
      </ul>
      <ul className="mt-5 grid grid-cols-3 gap-4 text-center text-small">
        {members.map((member) => (
          <li key={member.id}>
            <span className="font-medium">{member.name}</span>
            <span className="text-muted"> · {member.animal}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
