import type { ReasoningEffort } from "../../../src/runtime/policy.ts";
import type { DesktopBotView } from "../host/fleet.ts";
import { isReasoningEffort, LARK_PLATFORMS } from "./bridge.ts";
import type { DesktopSnapshot, Phase } from "./model.ts";
import { type ProblemCode, problem } from "./problem.ts";

/**
 * The one naming and status vocabulary for every surface: the menu bar, the
 * companion, Settings and first-run setup. A surface may choose how much of a
 * state to show, never a second word for it.
 *
 * - The application is Mochi.
 * - What a customer creates and names is a 伙伴. The customer's own name for it
 *   (`label`) is used wherever a flow speaks about it; no flow hard-codes the
 *   first character's name.
 * - 机器人 only ever means the Feishu bot the 伙伴 speaks through: 飞书机器人.
 */
export const NAMES = {
  application: "Mochi",
  companion: "伙伴",
  feishuBot: "飞书机器人",
} as const;

/** The word for a context window nearing its limit, and for clearing it. */
export const MEMORY = {
  full: "记忆快满了",
  organize: "整理记忆",
  organizing: "正在整理记忆",
  used: "记忆已用",
} as const;

/** Status tone. Green only for confirmed work; amber asks for attention. */
export type StatusTone = "good" | "pending" | "muted" | "error";

export interface StatusWord {
  label: string;
  tone: StatusTone;
}

/** Deployment-wide phases, as the menu bar summarizes them. */
export const PHASE_WORDS: Record<Phase, StatusWord> = {
  checking: { label: "正在确认状态", tone: "muted" },
  notInstalled: { label: "等待完成准备", tone: "muted" },
  stopped: { label: "已暂停", tone: "muted" },
  starting: { label: "正在启动", tone: "pending" },
  listening: { label: "正在值班", tone: "good" },
  working: { label: "正在回复", tone: "good" },
  contextFull: { label: MEMORY.full, tone: "pending" },
  organizingContext: { label: MEMORY.organizing, tone: "pending" },
  attention: { label: "需要你看一下", tone: "pending" },
};

/** The backend is not running: nothing is on duty, whatever was last saved. */
export const NOT_RUNNING: StatusWord = {
  label: `${NAMES.application} 没有运行`,
  tone: "muted",
};
export const START_APPLICATION = `启动 ${NAMES.application}`;

const LIFECYCLE_WORDS: Record<DesktopBotView["lifecycle"], StatusWord> = {
  paused: { label: "已暂停", tone: "muted" },
  starting: { label: "正在启动", tone: "pending" },
  setup: { label: "还没设置好", tone: "pending" },
  awaitingLogin: { label: "等待模型连接", tone: "pending" },
  awaitingConnection: { label: "等待群聊连接", tone: "pending" },
  listening: { label: "正在值班", tone: "good" },
  blocked: { label: "需要你看一下", tone: "pending" },
  stopping: { label: "正在停止", tone: "muted" },
  failed: { label: "没能启动", tone: "error" },
};

/** Feishu is connected, but its event stream is not delivering messages. */
const STREAM_DOWN = "event_stream_unavailable";

/** Repeated names remain distinguishable without renaming the customer's 伙伴. */
export function botDisplayLabel(
  bot: DesktopBotView,
  bots: readonly DesktopBotView[],
): string {
  const namesakes = bots.filter((entry) => entry.label === bot.label);
  return namesakes.length > 1
    ? `${bot.label}（${namesakes.findIndex((entry) => entry.botId === bot.botId) + 1}）`
    : bot.label;
}

/** The selected 伙伴's name for flow copy, or the application before one exists. */
export function companionName(snapshot: DesktopSnapshot): string {
  const bot = snapshot.bots.find(
    (entry) => entry.botId === snapshot.selectedBotId,
  );
  return bot ? botDisplayLabel(bot, snapshot.bots) : NAMES.application;
}

/** The verified active chat platform; setup needs no platform selector. */
export function chatServiceName(snapshot: DesktopSnapshot): string {
  const brand = snapshot.feishu.active?.brand;
  return brand ? LARK_PLATFORMS[brand].name : "飞书 / Lark";
}

const LATIN = /[A-Za-z0-9]/;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
/**
 * Chinese copy with interpolated names. A Latin name such as Mochi or Kiwi gets
 * the customary space where it meets Han characters, so one template serves
 * every name a customer might choose.
 */
export function zh(strings: TemplateStringsArray, ...values: string[]): string {
  let text = strings[0] ?? "";
  values.forEach((value, index) => {
    const next = strings[index + 1] ?? "";
    const lead = HAN.test(text.at(-1) ?? "") && LATIN.test(value[0] ?? "");
    const trail = LATIN.test(value.at(-1) ?? "") && HAN.test(next[0] ?? "");
    text += `${lead ? " " : ""}${value}${trail ? " " : ""}${next}`;
  });
  return text;
}

/**
 * One 伙伴 is one colleague: every group it answers in shares its memory. Said
 * once, in the same words, wherever groups are chosen.
 */
export function sharedMemoryNote(name: string): string {
  return zh`开启的群共用${name}的同一份记忆，就像同一位同事在几个群里。涉及其他群的私下讨论时，先判断是否适合在当前群转述。`;
}

/** The 伙伴's own problem, if its status names one this catalog can explain. */
export function botProblem(bot: DesktopBotView) {
  const code =
    bot.problemCode ??
    (bot.enabled && bot.lifecycle === "listening" && bot.phase === "attention"
      ? STREAM_DOWN
      : null);
  // The status reader admits only closed product problem codes.
  return code === null ? null : problem(code as ProblemCode);
}

/** A 伙伴 that stopped working on its own needs the customer to look. */
export function botNeedsAttention(bot: DesktopBotView): boolean {
  return (
    bot.problemCode !== null ||
    bot.lifecycle === "failed" ||
    bot.lifecycle === "blocked" ||
    (bot.enabled && bot.lifecycle === "listening" && bot.phase === "attention")
  );
}

/** What one 伙伴 is doing, in the words every surface uses. */
export function botStatus(bot: DesktopBotView): StatusWord {
  if (bot.phase === "starting") return LIFECYCLE_WORDS.starting;
  // Never configured is not the same as deliberately paused.
  if (bot.lifecycle === "setup") return LIFECYCLE_WORDS.setup;
  if (botNeedsAttention(bot)) {
    const explained = botProblem(bot);
    return explained
      ? {
          label: explained.title,
          tone: bot.lifecycle === "failed" ? "error" : "pending",
        }
      : bot.lifecycle === "failed"
        ? LIFECYCLE_WORDS.failed
        : LIFECYCLE_WORDS.blocked;
  }
  if (!bot.enabled) return LIFECYCLE_WORDS.paused;
  if (bot.phase === "contextFull") return PHASE_WORDS.contextFull;
  if (bot.phase === "working") return PHASE_WORDS.working;
  if (bot.phase === "organizingContext") return PHASE_WORDS.organizingContext;
  return LIFECYCLE_WORDS[bot.lifecycle];
}

/** Reasoning depths form a closed product vocabulary; catalog order stays the model's. */
const EFFORT_WORDS: Readonly<Record<ReasoningEffort, string>> = {
  none: "直接回答",
  minimal: "极浅",
  low: "浅",
  medium: "适中",
  high: "深入",
  xhigh: "更深入",
  max: "最深入",
};
export function effortLabel(id: string): string {
  return isReasoningEffort(id) ? EFFORT_WORDS[id] : id;
}
