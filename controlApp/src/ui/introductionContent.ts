import evan from "./assets/introduction/evan.png";
import jules from "./assets/introduction/jules.png";
import mochi from "./assets/introduction/mochi.png";
import nora from "./assets/introduction/nora.png";
import riley from "./assets/introduction/riley.png";
import theo from "./assets/introduction/theo.png";
import content from "./introductionStories.json" with { type: "json" };

export const participants = {
  jules: { name: "Jules", role: "产品", avatar: jules },
  nora: { name: "Nora", role: "运营", avatar: nora },
  theo: { name: "Theo", role: "设计", avatar: theo },
  evan: { name: "Evan", role: "研发", avatar: evan },
  riley: { name: "Riley", role: "负责人", avatar: riley },
  mochi: { name: "麻薯", badge: "机器人", avatar: mochi },
} as const;
export type Person = keyof typeof participants;
export type Story = (typeof content.stories)[number];
export type Evidence = (typeof content.evidence)[number];
export const introductionContent = content;

// Professions read the same in the choice and in the chat.
for (const story of content.stories) {
  const person = participants[story.perspective as Person];
  if (!("role" in person) || person.role !== story.role)
    throw new Error(`Introduction role mismatch: ${story.perspective}`);
}

// These are authored, local examples. A broken reference fails at build/test time.
for (const story of content.stories) {
  if (!(story.perspective in participants))
    throw new Error("Unknown story perspective");
  for (const message of story.messages) {
    if (!(message.speaker in participants))
      throw new Error("Unknown story speaker");
    for (const [, id] of message.text.matchAll(/\]\(#([^)]+)\)/g)) {
      if (
        !story.evidenceIds.includes(id!) ||
        !content.evidence.some((item) => item.id === id)
      )
        throw new Error(`Missing introduction evidence: ${id}`);
    }
  }
}
