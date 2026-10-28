import type { BotLayout, ProductLayout } from "../product/layout.ts";
import { productLayout } from "../product/layout.ts";
import { Fleet } from "../product/fleet.ts";
import { FeishuConnectionError } from "./connectionState.ts";
import { FeishuConnection } from "./connection.ts";
import { FeishuConnectionStore } from "./connectionStore.ts";

/** One Bot, one connection. The Bot's own directory decides which app it binds. */
export function createBotFeishuConnection(layout: BotLayout): FeishuConnection {
  return new FeishuConnection(
    productLayout().larkCliPath,
    new FeishuConnectionStore(layout.feishuConnectionDirectory),
    undefined, undefined, appId => assertFeishuOwnership(productLayout(), layout.botId, appId),
  );
}

/** One remote identity cannot feed two independent memories on the same host.
 * Called synchronously immediately before adopting/persisting a verified binding. */
export function assertFeishuOwnership(layout: ProductLayout, botId: string, appId: string): void {
  for (const bot of new Fleet(layout.fleetRecordPath).bots()) {
    if (bot.id === botId) continue;
    if (new FeishuConnectionStore(layout.bot(bot.id).feishuConnectionDirectory).read().active?.appId === appId) {
      throw new FeishuConnectionError("bot_already_connected");
    }
  }
}
