import { useEffect, useRef, useState } from "react";
import { MotionCanvas } from "../motion/canvas.ts";
import type {
  Character as CharacterDefinition,
  MotionCatalog,
} from "../motion/catalog.ts";
import { posePlacement } from "../motion/placement.ts";
import { StickerSurface } from "../motion/sticker.ts";
import {
  type EventRequest,
  type FramePose,
  MotionTimeline,
} from "../motion/timeline.ts";
import type { Phase, PreviewRequest } from "../shared/model.ts";
import { reportRendererHealth } from "./health.ts";
import { cn } from "./styles.ts";

export function Character({
  catalog,
  character,
  phase,
  preview,
  paper = false,
  curled = false,
  event,
  paused = false,
  painted,
}: {
  catalog: MotionCatalog;
  character: CharacterDefinition;
  phase: Phase;
  preview: PreviewRequest;
  paper?: boolean;
  curled?: boolean;
  event?: EventRequest | undefined;
  paused?: boolean;
  painted?(pose: FramePose, reduced: boolean): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const desired = useRef({
    phase,
    preview,
    paper,
    curled,
    event,
    paused,
    painted,
  });
  desired.current = { phase, preview, paper, curled, event, paused, painted };
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  // A settled reduced-motion pose stops the frame clock; any new input wakes it.
  const wake = useRef(() => {});
  useEffect(() => wake.current());
  useEffect(() => {
    const node = canvas.current;
    const source = document.createElement("canvas");
    const geometry = catalog.asset(character, character.rootAsset).geometry;
    source.width = geometry.canvasWidth;
    source.height = geometry.canvasHeight;
    const context = source.getContext("2d");
    if (!node || !context) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setReady(false);
    const player = new MotionTimeline(catalog, character);
    let active = true,
      frame = 0;
    let eventWasPlaying = false;
    let placementKey = "";
    const fail = () => {
      if (active) {
        active = false;
        cancelAnimationFrame(frame);
        setFailed(true);
        reportRendererHealth("motion-failed");
      }
    };
    const renderer = new MotionCanvas(context, catalog, character, fail);
    let sticker: StickerSurface;
    try {
      sticker = new StickerSurface(node, source, fail);
    } catch {
      renderer.dispose();
      fail();
      return;
    }
    const resize = () => {
      const bounds = node.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0)
        sticker.resize(
          bounds.width * devicePixelRatio,
          bounds.height * devicePixelRatio,
        );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    window.addEventListener("resize", resize);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let scheduled = false;
    const schedule = () => {
      if (!active || scheduled) return;
      scheduled = true;
      frame = requestAnimationFrame((time) => {
        scheduled = false;
        tick(time);
      });
    };
    const tick = (now: number, first = false) => {
      if (!active) return;
      const current = desired.current;
      const interrupted = eventWasPlaying && !current.event;
      if (interrupted) player.cancelEvent();
      eventWasPlaying = current.event !== undefined;
      player.setTarget(current.phase, current.preview, current.event);
      if ((document.hidden || current.paused) && !first && !interrupted) {
        player.pause();
        schedule();
        return;
      }
      let still = false;
      try {
        const pose = player.tick(now, renderer.ready, reduced.matches);
        still = reduced.matches && pose.type === "asset";
        const changed = renderer.draw(pose);
        const placement = posePlacement(catalog, character, pose);
        const key = JSON.stringify(placement);
        if (key !== placementKey) {
          node.style.setProperty("--pose-scale", String(placement.scale));
          node.style.setProperty(
            "--pose-anchor-x",
            `${placement.anchorX * 100}%`,
          );
          node.style.setProperty(
            "--pose-overhang",
            `${placement.overhang * 100}%`,
          );
          placementKey = key;
        }
        sticker.draw(
          changed,
          current.paper,
          current.curled,
          reduced.matches,
          now,
        );
        current.painted?.(pose, reduced.matches);
      } catch {
        fail();
        return;
      }
      // Reduced motion shows a still: nothing changes until an input does.
      if (!still) schedule();
    };
    void renderer
      .prepare()
      .then(() => {
        if (active) {
          // Inputs may change while a new character's images are loading.
          // Expose its frame clock only once its stable assets are available.
          wake.current = schedule;
          reduced.addEventListener("change", schedule);
          tick(performance.now(), true);
          if (active) {
            setReady(true);
            reportRendererHealth("motion-ready");
          }
        }
      })
      .catch(fail);
    return () => {
      active = false;
      wake.current = () => {};
      reduced.removeEventListener("change", schedule);
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      renderer.dispose();
      sticker.dispose();
    };
  }, [catalog, character]);
  const geometry = catalog.asset(character, character.rootAsset).geometry;
  if (failed)
    return (
      <div
        className={cn(
          // The character's placement anchor can be only one pixel wide. Its
          // recovery surface owns a readable width, independent of that anchor.
          "left-1/2 w-44 -translate-x-1/2 rounded-lg bg-surface px-3 py-2 text-center text-sm leading-5 text-ink shadow-control",
          event ? "fixed top-1/2 -translate-y-1/2" : "absolute bottom-3",
        )}
        role="alert"
      >
        角色暂时无法显示
        <small className="mt-1 block text-muted">
          请退出并重新打开 Mochi。
        </small>
      </div>
    );
  return (
    <canvas
      ref={canvas}
      data-renderer="sticker"
      data-ready={ready}
      className={cn(
        "absolute bottom-0 left-1/2 block h-[calc(var(--cat-size)*var(--pose-scale,1))] w-auto -translate-x-(--pose-anchor-x) translate-y-(--pose-overhang)",
        !event &&
          "max-h-[calc(100%/(1_-_var(--body-overhang))*var(--pose-scale,1))]",
      )}
      width={geometry.canvasWidth}
      height={geometry.canvasHeight}
      role="img"
      aria-label={character.displayName}
    />
  );
}
