import { type CSSProperties, useEffect, useRef, useState } from "react";
import { entrancePose } from "../../../controlApp/src/motion/entrance.ts";
import { Conversation } from "../conversation.tsx";
import { art } from "../media.ts";
import type { EntranceStage } from "../stage.ts";
import { threads } from "../threads.ts";
import { cn, Picture } from "../ui.tsx";
import { Clip, prefersStillness } from "../video.tsx";

const unit = (value: number) => Math.max(0, Math.min(1, value));

/* The card is both destination and occluder: the flight lifts the actor
   clear of its edge, so it can pass from behind the card to on top of it. */
const LIFT = 0.2;

/** waiting → performing → landed; or straight to still when motion can't play. */
type Scene = "waiting" | "performing" | "landed" | "still";

/**
 * The hero: an example conversation on a warm card, and Mochi's approved
 * entrance landing on its edge. The video clock owns the acting and the
 * spatial arc; the example stays readable while it arrives. Once
 * landed, Mochi can be petted: it plays the companion's own idle gesture.
 */
export function HeroStage({ stage }: { stage: EntranceStage }) {
  const actor = useRef<HTMLDivElement>(null);
  const entrance = useRef<HTMLVideoElement>(null);
  const pet = useRef<HTMLVideoElement>(null);
  const [scene, setScene] = useState<Scene>("waiting");
  const [motion, setMotion] = useState(false);
  const [petting, setPetting] = useState(false);
  const [petted, setPetted] = useState(false);
  const edge = stage.bodyBottom;

  useEffect(() => {
    if (prefersStillness()) {
      setScene("still");
    } else setMotion(true);
  }, []);

  useEffect(() => {
    if (!motion) return;
    const node = entrance.current!;
    const body = actor.current!;
    let frame = 0;
    let done = false;
    const still = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      body.style.transform = "";
      setScene("still");
    };
    // A slow network or a refused autoplay still ends on a landed Mochi.
    const patience = window.setTimeout(still, 4000);
    const place = () => {
      const scale = body.offsetWidth / stage.size;
      const position = node.currentTime * stage.framesPerSecond;
      const pose = entrancePose(position, stage);
      const flight = unit((position - stage.jump) / (stage.land - stage.jump));
      const hidden = (edge - stage.visualTop) * scale;
      const lift = 4 * LIFT * hidden * flight * (1 - flight);
      // The video leaps toward the viewer and lands where it started, as
      // its stage records: the actor only rises, never slides sideways.
      const y = pose.belowEdge * hidden - lift;
      body.style.transform = `translate3d(0, ${y}px, 0)`;
      body.dataset.front = String(flight >= 0.5);
      if (node.ended) {
        done = true;
        setScene("landed");
      } else frame = requestAnimationFrame(place);
    };
    const begin = () => {
      window.clearTimeout(patience);
      setScene("performing");
      node.play().then(() => {
        frame = requestAnimationFrame(place);
      }, still);
    };
    place();
    if (node.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) begin();
    else node.addEventListener("canplaythrough", begin, { once: true });
    node.addEventListener("error", still, { once: true });
    return () => {
      done = true;
      window.clearTimeout(patience);
      cancelAnimationFrame(frame);
    };
  }, [motion, stage, edge]);

  const stroke = () => {
    const node = pet.current;
    if (scene !== "landed" || petting || !node) return;
    setPetted(true);
    node.currentTime = 0;
    node.play().catch(() => setPetting(false));
  };

  const percent = (value: number) => `${(value / stage.size) * 100}%`;
  const canvas = {
    left: percent(stage.rootX),
    top: percent(stage.rootY),
    width: percent(stage.rootSize),
  };
  const geometry = {
    "--center": (stage.visualLeft + stage.visualWidth / 2) / stage.size,
    "--edge": edge / stage.size,
    // Reserve exactly the approved body height above the card.
    marginTop: `calc(var(--stage) * ${(edge - stage.visualTop) / stage.size} + 20px)`,
  } as CSSProperties;
  return (
    <div
      data-hero-stage
      data-scene={scene}
      style={geometry}
      className="relative [--perch:60%] [--stage:230px] md:[--stage:260px]"
    >
      <div
        ref={actor}
        data-front="false"
        className="pointer-events-none absolute z-0 aspect-square w-(--stage) will-change-transform data-[front=true]:z-2 in-data-[scene=landed]:z-2 in-data-[scene=still]:z-2"
        style={{
          left: "calc(var(--perch) - var(--stage) * var(--center))",
          top: "calc(var(--stage) * var(--edge) * -1)",
        }}
      >
        {motion && scene !== "still" ? (
          <>
            <Clip
              name="entrance"
              ref={entrance}
              className={cn(
                "absolute inset-0 size-full",
                (scene === "waiting" || petting) && "opacity-0",
              )}
            />
            <div className="absolute" style={canvas}>
              {/* Starts and ends on the root pose: the swap shows no seam. */}
              <Clip
                name="pet"
                ref={pet}
                onPlaying={() => setPetting(true)}
                onEnded={() => setPetting(false)}
                preload={scene === "landed" ? "auto" : "none"}
                className={cn("block h-auto w-full", !petting && "opacity-0")}
              />
            </div>
          </>
        ) : (
          <div data-still className="absolute" style={canvas}>
            <Picture
              picture={art.mochi}
              alt=""
              sizes="(min-width: 768px) 228px, 168px"
              className="h-auto w-full"
              priority
            />
          </div>
        )}
        {scene === "landed" && (
          <button
            type="button"
            aria-label="摸摸麻薯"
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") stroke();
            }}
            onClick={stroke}
            className="pointer-events-auto absolute cursor-grab rounded-[40%] focus-visible:outline-offset-[-6px] active:cursor-grabbing"
            style={{
              left: percent(stage.visualLeft),
              top: percent(stage.visualTop),
              width: percent(stage.visualWidth),
              height: percent(stage.bodyBottom - stage.visualTop),
            }}
          />
        )}
        <p
          aria-hidden
          className={cn(
            "absolute hidden whitespace-nowrap font-brand text-caption text-muted transition-opacity duration-500 lg:block",
            scene === "landed" && !petted
              ? "opacity-100 delay-1000"
              : "opacity-0",
          )}
          style={{
            left: percent(stage.visualLeft + stage.visualWidth + 12),
            top: percent(stage.visualTop + 120),
          }}
        >
          ← 摸摸它
        </p>
      </div>
      <Conversation
        thread={threads.hero}
        playback="none"
        className="hero-conversation relative z-1 rounded-[24px] bg-card px-4 pt-5 pb-6 shadow-card md:px-6 md:pt-6"
      >
        <header className="mb-5">
          <p className="mb-2 text-caption text-muted">示例对话</p>
          <h2 className="text-[17px] leading-6 font-medium">
            {threads.hero.title}
          </h2>
        </header>
      </Conversation>
    </div>
  );
}
