import { AbsoluteFill, Sequence } from "remotion";
import { ChatCard, Composer, Message, SourceCard, Thinking } from "./lib/Chat.tsx";
import { ClockHands } from "./lib/Clock.tsx";
import { FadeFromBlack, Line, Scene, Sound } from "./lib/Cut.tsx";
import { EndCard } from "./lib/EndCard.tsx";
import { Breathing, grade, Look } from "./lib/Look.tsx";
import { At, Shot } from "./lib/Shot.tsx";
import { s } from "./lib/time.ts";
import { Speak } from "./lib/Language.tsx";
import { type Language, words } from "./script.ts";

/** The 16:9 film, 88 seconds. Every cue is in seconds of film time. */
export const FILM_SECONDS = 88;
/** Where tools/score.ts's bar 1 falls: back at Nora's desk, just before Mochi. */
const SCORE_AT = 36;

export function Film({ language }: { language: Language }) {
  const { verse, question, answer, answerSource, noraReplies, morning } = words[language];
  return (
    <Speak language={language}>
      <AbsoluteFill style={{ backgroundColor: "#07080c" }}>
        {/* I · Night. The city goes to sleep window by window until one is left,
            and the camera drifts in toward it. The take starts once the film is
            out of black, so the last other windows go dark at 0:02.3. */}
        <Scene from={0} to={9.2} fadeIn={1.6} fadeOut={0.6}>
          <Shot clip={{ name: "city", at: s(1.6) }} from={{ scale: 1.0, x: 50, y: 50 }} to={{ scale: 1.4, x: 56.5, y: 52 }} grade={grade.night}>
            <At x={53.2} y={54.4}>
              <Breathing colour="rgba(255, 186, 104, 1)" size={260} strength={0.5} />
            </At>
          </Shot>
        </Scene>

        {/* Nora, waiting, then typing the question: her chin leaves her hand at 0:10.3. */}
        <Scene from={8.6} to={14.2} fadeIn={0.6} fadeOut={0.5}>
          <Shot clip={{ name: "nora-type" }} from={{ scale: 1.03, x: 56, y: 46 }} to={{ scale: 1.13, x: 62, y: 41 }} grade={grade.night}>
            <At x={86} y={48}>
              <Breathing colour="rgba(255, 178, 92, 1)" size={420} strength={0.32} />
            </At>
          </Shot>
        </Scene>

        {/* The question goes out. */}
        <Scene from={13.8} to={19.2} fadeIn={0.5} fadeOut={0.5}>
          <Shot clip={{ name: "nora-type", at: -s(5.2) }} from={{ scale: 1.1, x: 60, y: 42 }} to={{ scale: 1.14, x: 62, y: 41 }} grade={grade.behindCard(grade.night)} breathe={false} />
          <ChatCard>
            <Message who="nora" self at={s(3.15)} typing={false} runs={[question]} />
            <Composer text={question} from={s(0.6)} to={s(2.8)} sentAt={s(3.1)} />
          </ChatCard>
        </Scene>

        {/* Nobody. */}
        <Scene from={19.0} to={22.0} fadeIn={0.4}>
          <Shot still="empty-desk" from={{ scale: 1.0, x: 46, y: 50 }} to={{ scale: 1.07, x: 52, y: 50 }} grade={grade.night} />
        </Scene>
        <Scene from={21.8} to={24.3} fadeIn={0.3}>
          <Shot still="clock" from={{ scale: 1.0, x: 51.3, y: 48.5 }} to={{ scale: 1.06, x: 51.3, y: 48.5 }} grade={grade.night}>
            <ClockHands x={51.3} y={48.5} radius={14.6} />
          </Shot>
        </Scene>
        {/* Close on Nora: she glances up at the clock (0:24.1) and sighs (0:26.2). */}
        <Scene from={24.0} to={26.9} fadeIn={0.3} fadeOut={0.3}>
          <Shot clip={{ name: "nora-wait", at: -s(1.2) }} from={{ scale: 1.0, x: 50, y: 50 }} to={{ scale: 1.05, x: 50, y: 48 }} grade={grade.night} />
        </Scene>
        <Line from={19.6} to={25.9} text={verse.findTheRightPerson} />

        {/* II · The scattered day, remembered. */}
        <Scene from={26.6} to={30.0} fadeIn={0.35}>
          <Shot still="jules-paper" from={{ scale: 1.08, x: 48, y: 52 }} to={{ scale: 1.16, x: 46, y: 50 }} grade={grade.memory} />
        </Scene>
        <Scene from={29.8} to={33.2} fadeIn={0.25}>
          <Shot still="riley-meeting" from={{ scale: 1.06, x: 46, y: 50 }} to={{ scale: 1.14, x: 50, y: 48 }} grade={grade.memory} />
        </Scene>
        {/* Evan is tapped, again and again, and the bubbles crowd him; at 0:35.5
            his eyes slide to the finger. The film cuts straight to the night on
            the score's first bar. */}
        <Scene from={33.0} to={36.0} fadeIn={0.25}>
          <Shot clip={{ name: "evan-tap", at: -s(2.0) }} from={{ scale: 1.04, x: 50, y: 48 }} to={{ scale: 1.1, x: 52, y: 47 }} grade={grade.memory} />
        </Scene>
        <Line from={27.1} to={31.3} text={verse.nobodyFollowsUp} />
        <Line from={31.6} to={35.9} text={verse.explainAgain} />

        {/* III · Back to the night: Mochi arrives on the edge of the screen. The
            take starts at 0:36.6, so its ears rise on the score's high C (0:37.2)
            and its paws land on bar 2 (0:40.0). The camera stays wide through the
            leap. */}
        <Scene from={36.0} to={48.4} fadeOut={0.5}>
          <Shot clip={{ name: "arrival", at: s(0.6), first: 1 }} from={{ scale: 1.0, x: 50, y: 50 }} to={{ scale: 1.1, x: 47, y: 50 }} grade={grade.night} />
        </Scene>

        {/* The answer, with its sources. */}
        <Scene from={48.0} to={56.8} fadeIn={0.5} fadeOut={0.5}>
          <Shot still="key-arrival" from={{ scale: 1.12, x: 38, y: 42 }} to={{ scale: 1.15, x: 38, y: 42 }} grade={grade.behindCard(grade.night)} breathe={false} />
          <ChatCard>
            <Message who="nora" self at={-s(10)} typing={false} runs={[question]} />
            <Thinking at={s(0.5)} until={s(1.6)} />
            <Message who="mochi" at={s(1.6)} runs={answer} />
            <SourceCard at={s(5.3)} {...answerSource} />
            <Message who="nora" self at={s(7.0)} typing={false} runs={[noraReplies]} />
          </ChatCard>
        </Scene>

        {/* A breath with the two of them, for the bar that closes the night. */}
        <Scene from={56.4} to={60.3} fadeIn={0.4} fadeOut={0.6}>
          <Shot still="key-arrival" from={{ scale: 1.26, x: 44, y: 38 }} to={{ scale: 1.32, x: 44, y: 37 }} grade={grade.night} />
        </Scene>

        {/* IV · The next day, dissolving in across bar 7 (1:00), where the score turns to day. */}
        <Scene from={59.7} to={63.4} fadeIn={0.6} fadeOut={0.4}>
          <Shot still="morning" from={{ scale: 1.04, x: 46, y: 50 }} to={{ scale: 1.12, x: 52, y: 48 }} />
        </Scene>
        <Scene from={63.0} to={66.9} fadeIn={0.4} fadeOut={0.4}>
          <Shot still="morning" from={{ scale: 1.12, x: 52, y: 48 }} to={{ scale: 1.14, x: 53, y: 48 }} grade={grade.behindCard()} breathe={false} />
          <ChatCard>
            {/* Each arrives a sixteenth after a melody note, so its pop is heard between them. */}
            <Message who="jules" at={s(0.25)} typing={false} runs={[morning.jules]} />
            <Message who="mochi" at={s(1.25)} runs={morning.mochi} />
            <Message who="evan" at={s(2.75)} typing={false} runs={[morning.evan]} />
          </ChatCard>
        </Scene>
        {/* Dusk: they walk out waving, Theo last (0:69.0); once the room is empty
            its light goes (0:70.8 to 0:71.7), and only the laptop stays lit. */}
        <Scene from={66.5} to={72.6} fadeIn={0.4} fadeOut={0.6}>
          <Shot clip={{ name: "dusk", at: -s(1.7) }} from={{ scale: 1.06, x: 40, y: 50 }} to={{ scale: 1.14, x: 56, y: 48 }} />
        </Scene>
        <Line from={60.3} to={63.0} text={verse.someoneFollowsUp} />

        {/* V · Night again. Mochi keeps watch, and wakes for a message: in the
            take starting at 0:73.0 the screen lights at 0:75.4 and its eyes open
            at 0:77.6. */}
        <Scene from={72.2} to={81.0} fadeIn={0.8} fadeOut={0.8}>
          <Shot clip={{ name: "night", at: s(0.8) }} from={{ scale: 1.02, x: 47, y: 50 }} to={{ scale: 1.1, x: 45, y: 50 }} grade={grade.night} />
        </Scene>
        <Line from={78.0} to={80.9} text={verse.waiting} at={{ x: 72, y: 47 }} />

        {/* The end card: Mochi, then its maker on the next beat (1:24.0). */}
        <Scene from={80.4} to={FILM_SECONDS} fadeIn={0.8}>
          <EndCard makerAt={s(3.6)} />
        </Scene>

        <Sequence from={0} durationInFrames={s(80.8)}>
          <Look />
        </Sequence>
        <Sequence from={s(80.8)}>
          <Look grain={0.035} vignette={0.12} />
        </Sequence>

        {/* Sound. The score enters at the desk; before it, only the room, the keys and the clock. */}
        <Sound file="score.wav" at={SCORE_AT} to={FILM_SECONDS} fadeOut={2} />
        <Sound file="sfx/room-night.wav" at={0} to={27.2} fadeIn={2} fadeOut={0.6} />
        {/* Her hands type from 0:10.8, stop to hesitate at 0:12.1, and type again from 0:13.35. */}
        <Sound file="sfx/typing.wav" at={10.75} to={12.15} volume={0.85} fadeOut={0.05} />
        <Sound file="sfx/typing.wav" at={13.35} to={14.4} volume={0.85} fadeOut={0.05} />
        <Sound file="sfx/typing.wav" at={14.4} />
        <Sound file="sfx/send.wav" at={16.75} volume={0.5} />
        {[19.8, 20.8, 21.8, 22.8, 23.8, 24.8, 25.8].map((at, i) => (
          <Sound key={at} file={i % 2 ? "sfx/tock.wav" : "sfx/tick.wav"} at={at} volume={at < 21.8 ? 0.35 : at < 24.4 ? 0.7 : 0.45} />
        ))}
        <Sound file="sfx/room-day.wav" at={26.6} to={36} volume={0.5} fadeIn={0.4} fadeOut={0.05} />
        {/* The day, remembered, gets busier shot by shot: paper, a marker, then the taps, each where the finger lands. */}
        <Sound file="sfx/paper.wav" at={26.7} to={30.0} volume={0.55} fadeOut={0.3} />
        <Sound file="sfx/marker.wav" at={29.9} to={33.2} volume={0.65} fadeOut={0.2} />
        {[33.25, 33.75, 34.25, 34.75, 35.08].map((at, i) => (
          <Sound key={at} file="sfx/tap.wav" at={at} volume={0.3 + i * 0.04} />
        ))}
        <Sound file="sfx/room-night.wav" at={36} to={60.3} fadeIn={0.1} fadeOut={0.6} />
        <Sound file="sfx/rustle.wav" at={37.2} volume={0.9} />
        <Sound file="sfx/rustle.wav" at={39.5} />
        <Sound file="sfx/land.wav" at={40.02} />
        <Sound file="sfx/pop.wav" at={49.6} />
        <Sound file="sfx/pop.wav" at={53.3} volume={0.85} />
        <Sound file="sfx/send.wav" at={54.85} />
        <Sound file="sfx/room-day.wav" at={59.7} to={72.6} fadeIn={0.6} fadeOut={0.8} />
        <Sound file="sfx/pop.wav" at={63.25} volume={0.8} />
        <Sound file="sfx/pop.wav" at={64.25} />
        <Sound file="sfx/pop.wav" at={65.75} volume={0.8} />
        <Sound file="sfx/steps.wav" at={66.5} />
        <Sound file="sfx/steps-theo.wav" at={69.85} />
        <Sound file="sfx/room-night.wav" at={72.2} to={FILM_SECONDS} fadeIn={0.8} fadeOut={3} />
        <Sound file="sfx/chime.wav" at={75.43} volume={0.45} />

        <FadeFromBlack />
      </AbsoluteFill>
    </Speak>
  );
}
