import type { Logger } from "../log.ts";
import type { StateStore } from "../state.ts";
import { type FeishuGroup, isFeishuChatId, isGroupAvatarUrl, isGroupName, MAXIMUM_FEISHU_GROUPS } from "./group.ts";
import { runLarkJson, type LarkContext } from "./process.ts";

class GroupInventoryError extends Error {}

export function parseBotGroups(value: unknown): Omit<FeishuGroup, "enabled">[] {
  if (!record(value) || value.ok !== true || value.identity !== "bot" || !record(value.data)
    || !record(value.meta) || !record(value.meta.pagination) || value.meta.pagination.complete !== true
    || value.data.has_more !== false || !Array.isArray(value.data.chats) || value.data.chats.length > MAXIMUM_FEISHU_GROUPS) {
    throw new GroupInventoryError("group_inventory_invalid_or_incomplete");
  }
  const groups = value.data.chats.map((item: unknown) => {
    if (!record(item) || !isFeishuChatId(item.chat_id)
      || item.chat_status !== "normal" || !["group", "topic"].includes(String(item.chat_mode))) {
      throw new GroupInventoryError("group_membership_invalid");
    }
    const name = item.name === "" || item.name === undefined ? null : item.name;
    if (!isGroupName(name)) throw new GroupInventoryError("group_name_invalid");
    // Missing/unsupported avatar is a display limitation, never a membership failure.
    const avatarUrl = isGroupAvatarUrl(item.avatar) ? item.avatar : null;
    return { id: item.chat_id, name, avatarUrl };
  });
  if (new Set(groups.map((group) => group.id)).size !== groups.length) throw new GroupInventoryError("group_inventory_duplicate");
  return groups;
}

/**
 * One owner for live membership and persisted participation. No conversation or
 * credentials are cached. The Bot's connection recheck keeps the list current;
 * an unknown chat proves membership again on the spot.
 */
export class FeishuGroups {
  #groups: Omit<FeishuGroup, "enabled">[] | null = null;
  #active = false;
  #started = false;
  #pending: Promise<boolean> | undefined;
  /** What the last `lark.groups.resolved` record said; a refresh that changes nothing is not logged. */
  #logged: { ids: ReadonlySet<string>; enabledCount: number } | null = null;

  constructor(
    private readonly config: LarkContext & { readonly targetAppId: string },
    private readonly state: Pick<StateStore, "groupEnabled" | "setGroupEnabled">,
    private readonly publish: (groups: readonly FeishuGroup[] | null) => void,
    private readonly log: Logger,
    private readonly read = runLarkJson,
  ) {}

  async start(): Promise<void> {
    if (this.#started) throw new Error("Group observation already started");
    this.#started = true;
    this.#active = true;
    await this.refresh();
  }

  stop(): void {
    this.#active = false;
    this.#groups = null;
  }

  snapshot(): readonly FeishuGroup[] | null {
    return this.#groups?.map((group) => ({ ...group, enabled: this.state.groupEnabled(this.config.targetAppId, group.id) })) ?? null;
  }

  /**
   * The display name a turn shows the model, so one Bot in several groups knows
   * where it is. null when the directory is unavailable or the group has no
   * name; callers say so rather than guess. Names never enter logs or diagnostics.
   */
  name(chatId: string): string | null {
    return this.#groups?.find((group) => group.id === chatId)?.name ?? null;
  }

  /**
   * Called before buffering/hydration/admission. A group the directory does not
   * confirm, which while it is unavailable is every group, needs a fresh
   * membership proof; a failed proof refuses the message.
   */
  async accepts(chatId: string): Promise<boolean> {
    if (!this.#active || !isFeishuChatId(chatId)) return false;
    if (this.#pending) await this.#pending;
    else if (!this.#groups?.some((group) => group.id === chatId)) await this.refresh();
    return this.#active && this.#groups?.some((group) => group.id === chatId) === true
      && this.state.groupEnabled(this.config.targetAppId, chatId);
  }

  setEnabled(chatId: string, enabled: boolean): void {
    if (!this.#active || !this.#groups?.some((group) => group.id === chatId)) {
      throw new Error("group_membership_unavailable");
    }
    // Persist before publishing. An I/O failure cannot masquerade as a successful switch.
    this.state.setGroupEnabled(this.config.targetAppId, chatId, enabled);
    this.publish(this.snapshot());
    this.log.info("lark.group.participation_changed", { chatId, enabled, source: "companion", appliesTo: "new_messages" });
  }

  refresh(): Promise<boolean> {
    if (!this.#active) return Promise.resolve(false);
    if (this.#pending) return this.#pending;
    this.#pending = this.#refresh().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #refresh(): Promise<boolean> {
    let groups: Omit<FeishuGroup, "enabled">[];
    try {
      groups = parseBotGroups(await this.read(this.config, [
        "im", "+chat-list", "--as", "bot", "--page-all", "--page-size", "100", "--page-limit", "10", "--json",
      ]));
    } catch (error) {
      if (this.#active) {
        this.#groups = null;
        this.#logged = null;
        this.publish(null);
        this.log.warn("lark.groups.unavailable", { source: "bot_membership",
          reason: error instanceof GroupInventoryError ? error.message : "provider_read_failed" });
      }
      return false;
    }
    if (!this.#active) return false;
    this.#groups = groups;
    const snapshot = this.snapshot()!;
    this.publish(snapshot);
    this.#logResolved(snapshot);
    return true;
  }

  /** The minute recheck usually finds the same groups; only a change, or recovery, is news. */
  #logResolved(snapshot: readonly FeishuGroup[]): void {
    const ids = new Set(snapshot.map((group) => group.id));
    const enabledCount = snapshot.filter((group) => group.enabled).length;
    const previous = this.#logged;
    const added = previous ? [...ids].filter((id) => !previous.ids.has(id)).length : ids.size;
    const removed = previous ? [...previous.ids].filter((id) => !ids.has(id)).length : 0;
    if (previous && added === 0 && removed === 0 && previous.enabledCount === enabledCount) return;
    this.#logged = { ids, enabledCount };
    this.log.info("lark.groups.resolved", { source: "bot_membership", count: ids.size, enabledCount,
      addedCount: added, removedCount: removed });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
