import type { DesktopSnapshot } from "../shared/model.ts";

/** Present-tense connection copy comes only from current host evidence, never activity history. */
export function connectionStatus(snapshot: DesktopSnapshot): string {
  if (snapshot.eventStreamReady) return "群聊连接好了";
  if (snapshot.phase === "checking") return "正在确认连接";
  if (snapshot.phase === "notInstalled") return "等待完成准备";
  const { active, candidate } = snapshot.feishu;
  if (active?.state === "checking") return "正在确认连接";
  if (active?.state === "unavailable") return "连接需要检查";
  if (candidate?.state === "registering") return "等待完成扫码";
  if (candidate?.state === "checking") return "正在确认新的机器人";
  if (candidate?.state === "ready") return "等待接入群聊";
  if (candidate?.state === "needsAction") return "等待完成机器人设置";
  if (active?.state === "ready")
    return snapshot.phase === "stopped"
      ? "群聊已连接，伙伴已暂停"
      : "群聊已连接，等待伙伴就绪";
  return "尚未连接群聊";
}
