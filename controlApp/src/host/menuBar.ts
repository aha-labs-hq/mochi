import type { DesktopSnapshot, Phase } from "../shared/model.ts";
import {
  botDisplayLabel,
  botNeedsAttention,
  botProblem,
  botStatus,
  NOT_RUNNING,
  PHASE_WORDS,
  START_APPLICATION,
  type StatusWord,
} from "../shared/vocabulary.ts";

export type MenuBarAction = "show" | "settings" | "start" | "stop" | "quit";
export type MenuBarIcon =
  | "awake"
  | "replying"
  | "sleeping"
  | "connecting"
  | "organizing"
  | "full"
  | "attention";
export interface MenuBarState {
  icon: MenuBarIcon;
  status: string;
  detail: string;
  tone: "quiet" | "good" | "pending" | "attention";
  development: boolean;
  serviceTitle: string;
  serviceOperation: "start" | "stop";
  serviceVisible: boolean;
  serviceEnabled: boolean;
}

const icons = {
  checking: "connecting",
  notInstalled: "sleeping",
  stopped: "sleeping",
  starting: "connecting",
  listening: "awake",
  working: "replying",
  contextFull: "full",
  organizingContext: "organizing",
  attention: "attention",
} as const satisfies Record<Phase, MenuBarIcon>;

const SETUP_WORDS = {
  install: PHASE_WORDS.notInstalled.label,
  checking: PHASE_WORDS.checking.label,
  signIn: "等待模型连接",
  signingIn: "正在连接模型",
  ready: "等待开始值班",
  initializing: PHASE_WORDS.starting.label,
} as const satisfies Record<NonNullable<DesktopSnapshot["setup"]>, string>;

function tone(word: StatusWord): MenuBarState["tone"] {
  return word.tone === "muted"
    ? "quiet"
    : word.tone === "error"
      ? "attention"
      : word.tone;
}

/**
 * Compact live facts for the native menu. Neither previews nor activity history
 * can supply connection evidence, and no product operations live in AppKit.
 *
 * Precedence: quitting, then a deployment or action problem, then first-run
 * setup, then the 伙伴 themselves. A roster never hides a failure.
 */
export function menuBarState(snapshot: DesktopSnapshot): MenuBarState {
  const service = {
    development: snapshot.development,
    serviceTitle: snapshot.loaded ? "停止全部伙伴" : START_APPLICATION,
    serviceOperation: snapshot.loaded ? "stop" : "start",
    serviceVisible: snapshot.installed,
    serviceEnabled: snapshot.installed && !snapshot.busy,
  } as const;
  if (snapshot.busy === "shutdown")
    return {
      ...service,
      icon: "sleeping",
      status: "正在退出…",
      detail: "正在结束工作并关闭所有后台进程",
      tone: "quiet",
    };
  if (snapshot.problem)
    return {
      ...service,
      icon: "attention",
      status: snapshot.problem.title,
      detail: snapshot.problem.message,
      tone: "attention",
    };
  if (snapshot.setup !== null)
    return {
      ...service,
      icon: "connecting",
      status: SETUP_WORDS[snapshot.setup],
      detail: feishuDetail(snapshot),
      tone: "quiet",
    };
  if (!snapshot.loaded && snapshot.installed)
    return {
      ...service,
      icon: "sleeping",
      status: NOT_RUNNING.label,
      detail: "不会接收新的群消息",
      tone: "quiet",
    };
  if (snapshot.bots.length > 1)
    return { ...service, ...fleetSummary(snapshot) };
  const word = PHASE_WORDS[snapshot.phase];
  const bot = snapshot.controlReady ? snapshot.bots[0] : undefined;
  let status = bot ? botStatus(bot).label : word.label;
  let detail =
    (bot && botNeedsAttention(bot) && botProblem(bot)?.message) ||
    feishuDetail(snapshot);
  if (snapshot.phase === "listening" && snapshot.feishuGroups !== null) {
    const count = snapshot.feishuGroups.filter((group) => group.enabled).length;
    status = count ? `正在值班 · ${count} 个群` : "已连接 · 尚未开启群聊回应";
  }
  if (snapshot.phase === "working" && (snapshot.queueDepth ?? 0) > 0)
    status += ` · ${snapshot.queueDepth} 条等待中`;
  if (snapshot.phase === "stopped") detail = "不会接收新的群消息";
  return {
    ...service,
    icon: icons[snapshot.phase],
    status,
    detail,
    tone:
      snapshot.phase === "attention" || (bot && botNeedsAttention(bot))
        ? "attention"
        : tone(word),
  };
}

function feishuDetail(snapshot: DesktopSnapshot): string {
  if (!snapshot.eventStreamReady || snapshot.feishuGroups === null)
    return snapshot.eventStreamReady ? "飞书已连接" : "飞书暂未连接";
  const count = snapshot.feishuGroups.filter((group) => group.enabled).length;
  return `飞书已连接 · ${count ? `在 ${count} 个群值班` : "尚未开启群聊回应"}`;
}

/** Several 伙伴: one that needs the customer outranks all that are fine. */
function fleetSummary(
  snapshot: DesktopSnapshot,
): Pick<MenuBarState, "icon" | "status" | "detail" | "tone"> {
  const bots = snapshot.bots;
  const total = `共 ${bots.length} 位伙伴`;
  if (!snapshot.controlReady)
    return {
      icon: "connecting",
      status: PHASE_WORDS.checking.label,
      detail: total,
      tone: "quiet",
    };
  const attention = bots.filter(botNeedsAttention);
  if (attention.length > 0) {
    const first = attention[0]!;
    return {
      icon: "attention",
      status:
        attention.length === 1
          ? `${botDisplayLabel(first, bots)}：${botStatus(first).label}`
          : `${attention.length} 位伙伴需要你看一下`,
      detail: total,
      tone: "attention",
    };
  }
  const onDuty = bots.filter(
    (bot) =>
      bot.enabled &&
      bot.lifecycle === "listening" &&
      bot.phase !== "attention" &&
      bot.phase !== "stopped",
  );
  const paused = bots.filter((bot) => !bot.enabled).length;
  if (onDuty.length > 0)
    return {
      icon: onDuty.some((bot) => bot.phase === "working")
        ? "replying"
        : "awake",
      status: `${onDuty.length} 位伙伴正在值班`,
      detail: paused ? `${total} · ${paused} 位已暂停` : total,
      tone: "good",
    };
  if (bots.some((bot) => bot.phase === "starting"))
    return {
      icon: "connecting",
      status: PHASE_WORDS.starting.label,
      detail: total,
      tone: "pending",
    };
  return {
    icon: "sleeping",
    status: bots.every((bot) => bot.lifecycle === "setup")
      ? "伙伴还没设置好"
      : "伙伴都已暂停",
    detail: total,
    tone: "quiet",
  };
}

export function parseMenuBarAction(value: string): MenuBarAction {
  if (
    value === "show" ||
    value === "settings" ||
    value === "start" ||
    value === "stop" ||
    value === "quit"
  )
    return value;
  throw new Error("Unknown native menu action");
}
