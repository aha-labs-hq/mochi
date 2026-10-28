import { AbsoluteFill, Sequence } from "remotion";
import { ChatCard, Composer, Message, SourceCard, Thinking } from "./lib/Chat.tsx";
import { ClockHands } from "./lib/Clock.tsx";
import { FadeFromBlack, Line, Scene, Sound } from "./lib/Cut.tsx";
import { LookUp } from "./lib/Desk.tsx";
import { EndCard } from "./lib/EndCard.tsx";
import { Breathing, grade, Look } from "./lib/Look.tsx";
import { At, Shot } from "./lib/Shot.tsx";
import { s } from "./lib/time.ts";
import { Speak } from "./lib/Language.tsx";
import { type Language, words } from "./script.ts";

/**
 * The 9:16 cut, 48 seconds: the same story told for a phone. It keeps the
 * night, the unanswered question, Mochi's arrival, the answer, the next
 * morning and the night watch; the remembered day and the dusk go. Every cue
 * is in seconds of this cut's time.
 */
export const TALL_SECONDS = 48;
/** Where score-tall.wav's first bar falls: back at Nora's desk, just before Mochi. */
const SCORE_AT = 10.2;
/** Cards are read on a phone: narrower, closer. */
const card = { width: 700, zoom: 1.42 };

export function FilmTall({ language }: { language: Language }) {
  const { verse, question, answer, answerSource, noraReplies, morning } = words[language];
  return (
    <Speak language={language}>
      <AbsoluteFill style={{ backgroundColor: "#07080c" }}>
        {/* Night. The city goes to sleep until one window is left; the last other
            window goes dark at 0:02.1. */}
        <Scene from={0} to={2.9} fadeOut={0.4}>
          <Shot clip={{ name: "city-tall" }} from={{ scale: 1.0, x: 50, y: 50 }} to={{ scale: 1.1, x: 58, y: 52 }} grade={grade.night}>
            <At x={50.6} y={54.4}>
              <Breathing colour="rgba(255, 186, 104, 1)" size={820} strength={0.5} />
            </At>
          </Shot>
        </Scene>

        {/* Nora, waiting, then typing: her hand leaves her chin at 0:03.4. */}
        <Scene from={2.6} to={5.3} fadeIn={0.4} fadeOut={0.4}>
          <Shot clip={{ name: "nora-type-tall", at: -s(0.7) }} from={{ scale: 1.0, x: 50, y: 50 }} to={{ scale: 1.05, x: 52, y: 48 }} grade={grade.night} />
        </Scene>

        {/* The question goes out. */}
        <Scene from={5.0} to={8.7} fadeIn={0.4} fadeOut={0.4}>
          <Shot clip={{ name: "nora-type-tall", at: -s(3.1) }} from={{ scale: 1.05, x: 52, y: 48 }} to={{ scale: 1.07, x: 52, y: 47 }} grade={grade.behindCard(grade.night)} breathe={false} />
          <ChatCard {...card} foot={700}>
            <Message who="nora" self at={s(2.1)} typing={false} runs={[question]} />
            <Composer text={question} from={s(0.45)} to={s(1.85)} sentAt={s(2.05)} />
          </ChatCard>
        </Scene>

        {/* Nobody. */}
        <Scene from={8.5} to={10.5} fadeIn={0.3}>
          {/* Framed high, so the line below falls on the dark wall, not the pale face. */}
          <Shot still="clock" from={{ scale: 1.0, x: 51.3, y: 55 }} to={{ scale: 1.05, x: 51.3, y: 55 }} grade={grade.night}>
            <ClockHands x={51.3} y={48.5} radius={14.6} />
          </Shot>
        </Scene>

        {/* Mochi lands on the screen's edge; cut to Nora as she notices. The
            vertical take starts at 0:11.2, so the ears rise on the high C
            (0:11.45) and the paws land at 0:15.1. */}
        <Scene from={10.2} to={15.6} fadeIn={0.3}>
          <Shot clip={{ name: "arrival-tall", at: s(1.0) }} from={{ scale: 1.0, x: 50, y: 50 }} to={{ scale: 1.03, x: 50, y: 52 }} grade={grade.night} />
        </Scene>
        {/* The first line rides over the cut to the laptop and fades as the ears rise. */}
        <Line from={8.7} to={12.0} text={verse.findTheRightPerson} />
        <Scene from={15.6} to={18.4} fadeOut={0.4}>
          <Shot still="plate-look" from={{ scale: 1.25, x: 72, y: 58 }} to={{ scale: 1.3, x: 71, y: 57 }} grade={grade.night}>
            <LookUp at={0.3} />
          </Shot>
        </Scene>

        {/* The answer, with its sources. */}
        <Scene from={18.0} to={26.4} fadeIn={0.4} fadeOut={0.4}>
          <Shot still="key-arrival" from={{ scale: 1.0, x: 40, y: 45 }} to={{ scale: 1.03, x: 40, y: 45 }} grade={grade.behindCard(grade.night)} breathe={false} />
          <ChatCard {...card} foot={420}>
            <Message who="nora" self at={-s(10)} typing={false} runs={[question]} />
            <Thinking at={s(0.5)} until={s(1.6)} />
            <Message who="mochi" at={s(1.6)} runs={answer} />
            {/* A sixteenth after the melody's note, so its pop is heard. */}
            <SourceCard at={s(5.45)} {...answerSource} />
            <Message who="nora" self at={s(6.6)} typing={false} runs={[noraReplies]} />
          </ChatCard>
        </Scene>

        {/* The next morning. */}
        <Scene from={26.0} to={28.4} fadeIn={0.5} fadeOut={0.4}>
          <Shot still="morning" from={{ scale: 1.08, x: 40, y: 50 }} to={{ scale: 1.14, x: 43, y: 49 }} />
        </Scene>
        <Scene from={28.0} to={34.4} fadeIn={0.4} fadeOut={0.5}>
          <Shot still="morning" from={{ scale: 1.14, x: 43, y: 49 }} to={{ scale: 1.16, x: 44, y: 49 }} grade={grade.behindCard()} breathe={false} />
          <ChatCard {...card} foot={720}>
            {/* Each arrives just after a melody note, so its pop is heard between them. */}
            <Message who="jules" at={s(0.45)} typing={false} runs={[morning.jules]} />
            <Message who="mochi" at={s(1.35)} runs={morning.mochi} />
            <Message who="evan" at={s(2.5)} typing={false} runs={[morning.evan]} />
          </ChatCard>
        </Scene>
        <Line from={30.6} to={34.2} text={verse.someoneFollowsUp} />

        {/* Night again. Mochi keeps watch, and wakes for a message: the vertical
            take is already playing as the shot opens, so the screen lights at
            0:36.0, on the chime, and the eyes open at 0:37.8. */}
        <Scene from={34.0} to={42.4} fadeIn={0.6} fadeOut={0.8}>
          <Shot clip={{ name: "night-tall", at: -s(0.17) }} from={{ scale: 1.0, x: 50, y: 50 }} to={{ scale: 1.04, x: 50, y: 48 }} grade={grade.night} />
          {/* The desk falls off toward the lens, so the last line has dark ground under it. */}
          <AbsoluteFill style={{ background: "linear-gradient(to top, rgba(6,8,14,.8) 0%, rgba(6,8,14,.55) 22%, transparent 42%)" }} />
        </Scene>
        <Line from={38.3} to={42.2} text={verse.waiting} />

        {/* The end card: Mochi, then its maker on the next beat (0:44.2). */}
        <Scene from={41.8} to={TALL_SECONDS} fadeIn={0.8}>
          <EndCard makerAt={s(2.4)} />
        </Scene>

        <Sequence from={0} durationInFrames={s(42.2)}>
          <Look />
        </Sequence>
        <Sequence from={s(42.2)}>
          <Look grain={0.035} vignette={0.12} />
        </Sequence>

        {/* Sound. */}
        <Sound file="score-tall.wav" at={SCORE_AT} to={TALL_SECONDS} fadeOut={1.5} />
        <Sound file="sfx/room-night.wav" at={0} to={26.4} fadeIn={1.5} fadeOut={0.4} />
        <Sound file="sfx/typing.wav" at={3.65} to={5.35} volume={0.85} fadeOut={0.05} />
        <Sound file="sfx/typing.wav" at={5.45} to={6.9} fadeOut={0.1} />
        <Sound file="sfx/send.wav" at={6.9} volume={0.5} />
        <Sound file="sfx/tick.wav" at={8.5} volume={0.7} />
        <Sound file="sfx/tock.wav" at={9.5} volume={0.7} />
        <Sound file="sfx/tick.wav" at={10.5} volume={0.4} />
        <Sound file="sfx/rustle.wav" at={11.45} volume={0.9} />
        <Sound file="sfx/rustle.wav" at={14.6} />
        <Sound file="sfx/land.wav" at={15.1} />
        <Sound file="sfx/pop.wav" at={19.6} />
        <Sound file="sfx/pop.wav" at={23.45} volume={0.6} />
        <Sound file="sfx/send.wav" at={24.45} />
        <Sound file="sfx/room-day.wav" at={26.0} to={34.4} fadeIn={0.5} fadeOut={0.5} />
        <Sound file="sfx/pop.wav" at={28.45} volume={0.8} />
        <Sound file="sfx/pop.wav" at={29.35} />
        <Sound file="sfx/pop.wav" at={30.5} volume={0.8} />
        <Sound file="sfx/room-night.wav" at={34.0} to={TALL_SECONDS} fadeIn={0.6} fadeOut={3} />
        <Sound file="sfx/chime.wav" at={36.0} volume={0.45} />

        <FadeFromBlack />
      </AbsoluteFill>
    </Speak>
  );
}
