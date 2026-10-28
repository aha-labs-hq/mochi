import { createContext, type CSSProperties, type ReactNode, useContext } from "react";
import { AbsoluteFill } from "remotion";
import { type Language, type Words, words } from "../script.ts";

/** How a language is set on screen. */
type Face = {
  /** The verse's face: a printed book's, like Songti for Chinese. */
  serif: string;
  /** Tracking for the verse; wide for CJK, close for Latin. */
  tracking: string;
  /** The interface's face, for the chat and the end card. */
  sans: string;
  /** What Mochi's words arrive in: a character at a time, or a word at a time where words are spelled out. */
  unit: "grapheme" | "word";
  /** Where lines may break: anywhere in Chinese, between phrases in Japanese, at spaces in Korean and English. */
  breaks: CSSProperties["wordBreak"];
};

const faces: Record<Language, Face> = {
  "zh-hans": { serif: '"Songti SC", "STSong", serif', tracking: "0.16em", sans: '-apple-system, "PingFang SC", sans-serif', unit: "grapheme", breaks: "normal" },
  "zh-hant": { serif: '"Songti TC", serif', tracking: "0.16em", sans: '-apple-system, "PingFang TC", sans-serif', unit: "grapheme", breaks: "normal" },
  en: { serif: '"Hoefler Text", serif', tracking: "0.03em", sans: "-apple-system, sans-serif", unit: "word", breaks: "normal" },
  ja: { serif: '"Hiragino Mincho ProN", serif', tracking: "0.12em", sans: '-apple-system, "Hiragino Sans", sans-serif', unit: "grapheme", breaks: "auto-phrase" },
  ko: { serif: '"Nanum Myeongjo", serif', tracking: "0.06em", sans: '-apple-system, "Apple SD Gothic Neo", sans-serif', unit: "grapheme", breaks: "keep-all" },
};

type Speech = Words & Face & { language: Language };
const Spoken = createContext<Speech | null>(null);

/** Everything inside speaks `language`: its words, its faces and its line breaks. */
export function Speak({ language, children }: { language: Language; children: ReactNode }) {
  const face = faces[language];
  return (
    <Spoken.Provider value={{ ...words[language], ...face, language }}>
      <AbsoluteFill lang={language} style={{ wordBreak: face.breaks }}>
        {children}
      </AbsoluteFill>
    </Spoken.Provider>
  );
}

export function useSpeech() {
  const speech = useContext(Spoken);
  if (!speech) throw new Error("useSpeech outside <Speak>");
  return speech;
}
