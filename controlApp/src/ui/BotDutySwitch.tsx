import type { DesktopBotView } from "../host/fleet.ts";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import { botDisplayLabel } from "../shared/vocabulary.ts";
import { Toggle } from "./Controls.tsx";

export function BotDutySwitch({
  bot,
  snapshot,
  act,
}: {
  bot: DesktopBotView;
  snapshot: DesktopSnapshot;
  act(action: DesktopAction): Promise<void>;
}) {
  // Nothing is on duty while the backend is not running, whatever was saved.
  const onDuty = snapshot.loaded && bot.enabled && snapshot.setup !== "ready";
  return (
    <Toggle
      size="compact"
      id={`bot-duty-${bot.botId}`}
      checked={onDuty}
      aria-label={`${botDisplayLabel(bot, snapshot.bots)}：值班`}
      title={onDuty ? "暂停值班" : "开始值班"}
      disabled={
        snapshot.busy !== null ||
        !snapshot.controlReady ||
        snapshot.setup === "initializing" ||
        (!bot.enabled && snapshot.account.status !== "signedIn")
      }
      onCheckedChange={(enabled) =>
        void act({ type: "setBotEnabled", botId: bot.botId, enabled })
      }
    />
  );
}
