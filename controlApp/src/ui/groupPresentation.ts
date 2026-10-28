import type { DesktopSnapshot } from "../shared/model.ts";

export function groupSummary(snapshot: DesktopSnapshot): string {
  if (snapshot.feishuGroups) {
    if (snapshot.feishuGroups.length === 0) return "还没有加入群聊";
    const enabled = snapshot.feishuGroups.filter(
      (group) => group.enabled,
    ).length;
    return enabled === 0 ? "所有群已暂停回应" : `在 ${enabled} 个群值班`;
  }
  if (snapshot.phase === "stopped") return "醒来后确认群聊";
  if (snapshot.phase === "checking" || snapshot.phase === "starting")
    return "正在确认群聊";
  return "所在群暂时无法确认";
}
