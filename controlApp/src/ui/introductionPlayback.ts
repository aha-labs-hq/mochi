import { animate } from "motion/react";

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const easeOut = (value: number) => 1 - (1 - clamp(value)) ** 3;
const readingEdge = 28;

/** Owns only transient row/glyph styles and scroll, never message content. */
export function introductionPlayback(
  history: HTMLElement,
  changed: () => void,
  announce: (text: string) => void,
) {
  const rows = Array.from(
    history.querySelectorAll<HTMLElement>("[data-message]"),
  );
  let animation: ReturnType<typeof animate> | null = null;
  let index = 0;
  let paused = false;
  let disposed = false;
  let manual = false;
  const status = (value: string) => {
    history.dataset.conversation = value;
    history.dataset.reading = String(manual);
    changed();
  };
  const finishRow = (row: HTMLElement) => {
    row.hidden = false;
    row.inert = false;
    row.removeAttribute("aria-hidden");
    row.removeAttribute("aria-busy");
    row.style.removeProperty("opacity");
    row.style.removeProperty("transform");
    row.dataset.state = "complete";
    for (const glyph of row.querySelectorAll<HTMLElement>("[data-glyph]"))
      glyph.style.opacity = "1";
  };
  const target = (bottom: number) =>
    Math.max(
      0,
      Math.min(
        history.scrollHeight - history.clientHeight,
        bottom - history.clientHeight + readingEdge,
      ),
    );

  function next() {
    if (disposed || manual) return;
    const row = rows[index++]!;
    row.hidden = false;
    row.removeAttribute("aria-hidden");
    row.setAttribute("aria-busy", "true");
    row.style.opacity = "0";
    const glyphs = Array.from(
      row.querySelectorAll<HTMLElement>("[data-glyph]"),
    );
    const typing = row.dataset.speaker === "mochi";
    row.dataset.state = typing ? "typing" : "entering";
    history.dataset.arrived = String(index);
    const step = Math.min(0.014, 1.8 / Math.max(1, glyphs.length - 1));
    const top = history.getBoundingClientRect().top;
    const offset = history.scrollTop;
    const rect = row.getBoundingClientRect();
    const bottom = rect.bottom - top + offset;
    const lines: { index: number; bottom: number }[] = [];
    for (const [i, glyph] of glyphs.entries()) {
      const lineBottom = glyph.getBoundingClientRect().bottom - top + offset;
      if (!lines.length || lineBottom > lines.at(-1)!.bottom + 2)
        lines.push({ index: i, bottom: lineBottom });
    }
    const fits = rect.height <= history.clientHeight - readingEdge * 2;
    const entryScroll = Math.max(
      offset,
      target(fits ? bottom : (lines[0]?.bottom ?? bottom)),
    );
    const needsScroll = entryScroll > offset + 1;
    const entryAt = needsScroll ? 0.18 : 0;
    const textAt = entryAt + 0.04;
    const end = typing
      ? textAt + 0.14 + step * Math.max(0, glyphs.length - 1)
      : entryAt + 0.18;
    const scrolls = [
      { from: offset, to: entryScroll, start: 0, duration: 0.28, eased: true },
    ];
    if (!fits && typing) {
      let cursor = needsScroll ? 0.28 : 0;
      let position = entryScroll;
      for (const [i, line] of lines.entries()) {
        const to = Math.max(
          position,
          target(i === lines.length - 1 ? bottom : line.bottom),
        );
        if (to <= position + 1) continue;
        const until = Math.max(
          cursor + 0.016,
          textAt + line.index * step - 0.06,
        );
        scrolls.push({
          from: position,
          to,
          start: cursor,
          duration: until - cursor,
          eased: false,
        });
        position = to;
        cursor = until;
      }
    }
    let finished = false;
    const duration = end + (index < rows.length ? 0.42 : 0);
    animation = animate(0, duration, {
      duration,
      ease: "linear",
      onUpdate(time) {
        if (!finished) {
          const entry = easeOut((time - entryAt) / 0.18);
          row.style.opacity = String(entry);
          row.style.transform = `translateY(${3 * (1 - entry)}px)`;
          glyphs.forEach((glyph, i) => {
            glyph.style.opacity = String(
              easeOut((time - textAt - i * step) / 0.14),
            );
          });
          if (time >= end) {
            finished = true;
            finishRow(row);
            announce(
              `${row.dataset.author}：${row.querySelector("[data-chat-bubble]")!.textContent}`,
            );
          }
        }
        for (const scroll of scrolls) {
          if (time < scroll.start) break;
          const progress = clamp((time - scroll.start) / scroll.duration);
          history.scrollTop =
            scroll.from +
            (scroll.to - scroll.from) *
              (scroll.eased ? easeOut(progress) : progress);
        }
        changed();
      },
      onComplete() {
        finishRow(row);
        animation = null;
        if (index < rows.length) next();
        else status("complete");
      },
    });
    if (paused) animation.pause();
    status(paused ? "paused" : "playing");
  }

  for (const row of rows) {
    row.hidden = true;
    row.inert = true;
    row.setAttribute("aria-hidden", "true");
    row.dataset.state = "pending";
  }
  history.scrollTop = 0;
  history.dataset.arrived = "0";
  status("ready");
  return {
    start() {
      if (index === 0 && !manual && !disposed) next();
    },
    pause(value: boolean) {
      paused = value;
      if (!animation) return;
      if (value) animation.pause();
      else animation.play();
      status(value ? "paused" : "playing");
    },
    read() {
      animation?.stop();
      animation = null;
      manual = true;
      rows.forEach(finishRow);
      history.dataset.arrived = String(rows.length);
      status("complete");
    },
    dispose() {
      disposed = true;
      animation?.stop();
    },
  };
}
