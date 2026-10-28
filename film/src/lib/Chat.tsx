import type { ReactNode } from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { palette } from "../palette.gen.ts";
import { useSpeech } from "./Language.tsx";
import { ramp, s } from "./time.ts";

/** The group's people. Their names are the same in every language; their roles, and Mochi's name, are the language's. */
const names = { nora: "Nora", jules: "Jules", evan: "Evan", riley: "Riley" } as const;
export type Person = keyof typeof names | "mochi";

/** A word that is a source: tinted like the website's links. */
export type Run = string | { source: string };

const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
const graphemes = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment);

/**
 * The card a group conversation sits on: the website's paper card, filmed
 * close. Like a chat window it is anchored at its foot, so each arrival opens
 * room above the composer and the conversation rises.
 */
export function ChatCard({ children, width = 820, zoom = 1.28, foot = 150 }: { children: ReactNode; width?: number; zoom?: number; foot?: number }) {
  const frame = useCurrentFrame();
  const { sans } = useSpeech();
  const inn = ramp(frame, 0, s(0.7));
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: foot }}>
      <div
        style={{
          width,
          padding: `${40 - GAP}px 44px 40px`,
          borderRadius: 32,
          background: palette.card,
          boxShadow: "0 2px 4px rgba(0,0,0,.08), 0 30px 80px -20px rgba(0,0,0,.45)",
          fontFamily: sans,
          color: palette.ink,
          opacity: inn,
          transformOrigin: "50% 100%",
          transform: `translateY(${(1 - inn) * 28}px) scale(${zoom * (0.985 + inn * 0.015)})`,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

const GAP = 26;

/**
 * One row of the conversation. It opens to its own height as `open` goes
 * from 0 to 1, so the card grows smoothly instead of jumping.
 */
function Row({ open, children }: { open: number; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateRows: `${open}fr` }}>
      <div style={{ minHeight: 0, overflow: "hidden", paddingTop: GAP }}>{children}</div>
    </div>
  );
}

/**
 * One message. It settles in at `at`; Mochi's words then appear grapheme by
 * grapheme, the rhythm the companion's introduction uses, or word by word in
 * a language that spells its words out.
 */
export function Message({
  who,
  self = false,
  at,
  runs,
  typing = who === "mochi",
}: {
  who: Person;
  self?: boolean;
  at: number;
  runs: Run[];
  typing?: boolean;
}) {
  const frame = useCurrentFrame() - at;
  const speech = useSpeech();
  if (frame < 0) return null;
  const inn = ramp(frame, s(0.08), s(0.45));
  const name = who === "mochi" ? speech.mochi : names[who];
  const role = who === "mochi" ? "" : speech.roles[who];
  const units = new Intl.Segmenter(speech.language, { granularity: speech.unit });
  let index = 0;
  const stagger = 1.3; // frames between units
  const glyph = (text: string, tint?: boolean) =>
    Array.from(units.segment(text), (part) => part.segment).map((g, i) => {
      const n = index++;
      const shown = typing ? ramp(frame, s(0.1) + n * stagger, s(0.1) + n * stagger + s(0.25)) : 1;
      return (
        <span key={`${n}${i}`} style={{ opacity: shown, color: tint ? palette.primary : undefined }}>
          {g}
        </span>
      );
    });
  return (
    <Row open={ramp(frame, 0, s(0.4))}>
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "48px 1fr 48px",
        columnGap: 14,
        rowGap: 6,
        opacity: inn,
        transform: `translateY(${(1 - inn) * 10}px)`,
      }}
    >
      <p
        style={{
          gridColumn: 2,
          margin: 0,
          padding: "0 16px",
          fontSize: 17,
          color: palette.muted,
          textAlign: self ? "right" : "left",
        }}
      >
        {name}
        {role && <span style={{ marginLeft: 10 }}>{role}</span>}
      </p>
      <Img
        src={staticFile(`people/${who}.png`)}
        style={{
          gridColumn: self ? 3 : 1,
          gridRow: 2,
          width: 48,
          height: 48,
          borderRadius: 24,
        }}
      />
      <div
        style={{
          gridColumn: 2,
          gridRow: 2,
          justifySelf: self ? "end" : "start",
          maxWidth: "100%",
          padding: "14px 20px",
          borderRadius: self ? "18px 6px 18px 18px" : "6px 18px 18px 18px",
          background: self ? palette.control : palette.note,
          fontSize: 25,
          lineHeight: 1.62,
        }}
      >
        {runs.map((run, i) =>
          typeof run === "string" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: authored, fixed runs.
            <span key={i}>{glyph(run)}</span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: authored, fixed runs.
            <span key={i}>{glyph(run.source, true)}</span>
          ),
        )}
      </div>
    </div>
    </Row>
  );
}

/** Mochi is reading the project: three dots, before the words. */
export function Thinking({ at, until }: { at: number; until: number }) {
  const frame = useCurrentFrame();
  // It folds away as the answer opens in its place, so the card's height eases from one to the other.
  const open = Math.min(ramp(frame, at, at + s(0.4)), 1 - ramp(frame, until, until + s(0.4)));
  if (frame < at || open === 0) return null;
  const local = frame - at;
  return (
    <Row open={open}>
    <div style={{ display: "flex", alignItems: "center", gap: 14, opacity: open }}>
      <Img src={staticFile("people/mochi.png")} style={{ width: 48, height: 48, borderRadius: 24 }} />
      <div style={{ display: "flex", gap: 8, padding: "18px 22px", borderRadius: "6px 18px 18px 18px", background: palette.note }}>
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            style={{
              width: 9,
              height: 9,
              borderRadius: 5,
              background: palette.muted,
              opacity: 0.35 + 0.65 * Math.max(0, Math.sin((local / 30) * Math.PI * 2 - dot * 0.9)),
            }}
          />
        ))}
      </div>
    </div>
    </Row>
  );
}

/** A sentence being typed into the group's composer, then sent. */
export function Composer({
  text,
  from,
  to,
  sentAt,
}: {
  text: string;
  from: number;
  to: number;
  sentAt: number;
}) {
  const frame = useCurrentFrame();
  const { send } = useSpeech();
  const parts = graphemes(text);
  const typed = frame >= sentAt ? 0 : Math.round(ramp(frame, from, to, (t) => t) * parts.length);
  const caret = Math.floor(frame / 16) % 2 === 0 && frame < sentAt;
  const pressed = frame >= sentAt - s(0.2) && frame < sentAt + s(0.15);
  return (
    <Row open={1}>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        marginTop: 8,
        padding: "16px 18px 16px 24px",
        borderRadius: 20,
        background: palette.surface,
        boxShadow: `inset 0 0 0 1px ${palette.hairline}`,
      }}
    >
      <p style={{ flex: 1, margin: 0, minHeight: 40, fontSize: 24, lineHeight: 1.62, color: palette.ink }}>
        {parts.slice(0, typed).join("")}
        <span style={{ display: "inline-block", width: 2, height: 28, marginLeft: 2, verticalAlign: -5, background: palette.primary, opacity: caret ? 1 : 0 }} />
      </p>
      <span
        style={{
          padding: "10px 18px",
          borderRadius: 12,
          background: typed > 0 || pressed ? palette.primary : palette.control,
          color: typed > 0 || pressed ? "#fff" : palette.muted,
          fontSize: 19,
          fontWeight: 500,
          transform: `scale(${pressed ? 0.94 : 1})`,
        }}
      >
        {send}
      </span>
    </div>
    </Row>
  );
}

/** A record Mochi cited, unfolding under the answer it supports. */
export function SourceCard({
  at,
  kind,
  title,
  state,
}: {
  at: number;
  kind: string;
  title: string;
  state: string;
}) {
  const frame = useCurrentFrame() - at;
  if (frame < 0) return null;
  const inn = ramp(frame, s(0.08), s(0.5));
  return (
    <Row open={ramp(frame, 0, s(0.4))}>
    <div
      style={{
        marginLeft: 62,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "16px 20px",
        borderRadius: 16,
        background: palette.surface,
        boxShadow: `inset 0 0 0 1.5px ${palette.actionSoft}`,
        opacity: inn,
        transform: `translateY(${(1 - inn) * 14}px)`,
      }}
    >
      <span style={{ fontSize: 16, color: palette.muted, whiteSpace: "nowrap" }}>{kind}</span>
      <span style={{ flex: 1, fontSize: 21, fontWeight: 500 }}>{title}</span>
      <span style={{ padding: "4px 12px", borderRadius: 999, background: palette.actionSoft, color: palette.primary, fontSize: 16, whiteSpace: "nowrap" }}>
        {state}
      </span>
    </div>
    </Row>
  );
}
