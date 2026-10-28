import {
  type Evidence,
  introductionContent,
  type Person,
  participants,
} from "../../controlApp/src/ui/introductionContent.ts";

/**
 * Conversations on the website. The five profession stories, their titles
 * and every source record are the companion's approved introduction; the
 * website adds only short threads that revisit the same fictional project
 * and cite the same records, so the two never tell different stories.
 */
export type Line = { speaker: Person; text: string } | { moment: string };

export interface Thread {
  id: string;
  title: string;
  /** Whose phone this is: their messages sit on the right. */
  perspective?: Person;
  lines: Line[];
}

export const stories: (Thread & { role: string })[] =
  introductionContent.stories.map((story) => ({
    id: story.id,
    role: story.role,
    title: story.title,
    perspective: story.perspective as Person,
    lines: story.messages.map((message) => ({
      speaker: message.speaker as Person,
      text: message.text,
    })),
  }));

export const threads = {
  hero: stories.find((story) => story.id === "operations")!,
  /** One week of the same request, told in three steps as the reader scrolls. */
  week: {
    id: "week",
    title: "公开链接免登录查看",
    lines: [
      { moment: "周一" },
      {
        speaker: "jules",
        text: "行，就这么改。@麻薯 派给 Evan，这次先把查看做好。",
      },
      {
        speaker: "mochi",
        text: "[#86](#share-scoped) 更新好了，已派给 **Evan**。",
      },
      { speaker: "evan", text: "收到，我来。" },
      { moment: "周三" },
      { speaker: "riley", text: "@麻薯 查看页这周能上线吗？" },
      {
        speaker: "mochi",
        text: "**现在还不能确定。**\n\n[PR #101](#preview-progress) 已经通过评审，正在等 Jules 试用确认，验收前不会上线。\n\nTheo 发在群里的设计稿是 PDF，我读不了正文，设计相关的判断只依据 [#104 里的版本](#design-today)。",
      },
      {
        speaker: "riley",
        text: "@麻薯 那每周五下午三点，核对发布前还卡着的事，发到这个群。",
      },
      {
        speaker: "mochi",
        text: "已安排：每周五 15:00（上海时间）核对发布阻塞，把结论发到这个群。下次是本周五。",
      },
      { moment: "周五 15:00" },
      {
        speaker: "mochi",
        text: "**本周发布核对**\n- 查看页已随 [v1.8.0 上线](#preview-release)，私密内容和留言仍需登录。\n- [五家客户的试用](#pilot-ready)等的就是它。",
      },
      { speaker: "nora", text: "好，邀请我现在发。" },
    ],
  },
} satisfies Record<string, Thread>;

/** How many lines of the week each scroll step has revealed. */
export const weekSteps = [4, 7, 12] as const;
if (weekSteps.at(-1) !== threads.week.lines.length)
  throw new Error("The last step must reveal the whole week");

export const evidence: Record<string, Evidence> = Object.fromEntries(
  introductionContent.evidence.map((item) => [item.id, item]),
);

export function speakerName(person: Person) {
  return participants[person].name;
}

// Every website thread cites only records the introduction already owns.
for (const thread of [...stories, ...Object.values(threads)])
  for (const line of thread.lines)
    if ("text" in line)
      for (const [, id] of line.text.matchAll(/\]\(#([^)]+)\)/g))
        if (!evidence[id!])
          throw new Error(`Thread ${thread.id} cites unknown evidence ${id}`);
