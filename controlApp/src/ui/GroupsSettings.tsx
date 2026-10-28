import { useState } from "react";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import type { DesktopProblem } from "../shared/problem.ts";
import { companionName, sharedMemoryNote } from "../shared/vocabulary.ts";
import { Toggle } from "./Controls.tsx";
import { Glyph } from "./Glyph.tsx";
import { GroupAvatar } from "./GroupAvatar.tsx";
import { SettingsList, SettingsRow } from "./SettingsList.tsx";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";

/**
 * Group participation is separate from the connection displayed above it. The
 * Bot keeps the list current, so the page has nothing to refresh.
 */
export function GroupsSettings({
  snapshot,
  act,
  busy: windowBusy,
  shownProblem,
}: {
  snapshot: DesktopSnapshot;
  act(action: DesktopAction): Promise<void>;
  /** The window is visibly busy; a moment-long action never sets it. */
  busy: boolean;
  shownProblem: DesktopProblem | null;
}) {
  const [search, setSearch] = useState("");
  const [changing, setChanging] = useState<string | null>(null);
  const [lastGroup, setLastGroup] = useState<string | null>(null);
  const busy = windowBusy || changing !== null;
  const available =
    snapshot.controlReady &&
    snapshot.setup !== "initializing" &&
    snapshot.feishu.active?.state === "ready";
  const groups = snapshot.feishuGroups;
  const visible = groups?.filter((group) =>
    (group.name ?? "未命名群")
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  if (!snapshot.feishu.active) return null;
  return (
    <section className="mt-10" aria-labelledby="groups-heading">
      <SettingsSectionHeader
        id="groups-heading"
        title="所在群"
        actions={
          groups !== null && (
            <span>
              {groups.length} 个群 ·{" "}
              {groups.filter((group) => group.enabled).length} 个开启回应
            </span>
          )
        }
        description={
          <p id="group-participation-help">
            <span className="block text-ink">
              {sharedMemoryNote(companionName(snapshot))}
            </span>
            <span className="block">
              新加入的群默认开启回应；关闭只停止接收新消息，已经接下的任务会继续完成。
            </span>
          </p>
        }
      />
      {groups && (groups.length > 6 || search) && (
        <div className="relative mb-3">
          <Glyph
            name="search"
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            aria-label="查找群聊"
            placeholder="查找群聊"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="field-focus h-9 w-full rounded-md border border-field-border bg-field pr-3 pl-8 text-sm"
          />
        </div>
      )}
      {shownProblem && !visible?.some((group) => group.id === lastGroup) && (
        <p role="alert" className="mb-3 text-sm leading-relaxed text-error">
          {shownProblem.message}
        </p>
      )}
      {groups === null ? (
        <p role="status" className="settings-card settings-note">
          还在确认所在群，确认后会自动显示在这里。
        </p>
      ) : groups.length === 0 ? (
        <div className="settings-card">
          <h3 className="settings-section-title">还没有加入群聊</h3>
          <p className="settings-note mt-1 [overflow-wrap:anywhere]">
            在群聊中邀请「
            {snapshot.feishu.active.bot?.name ?? "你的机器人"}
            」，它就会出现在这里。
          </p>
        </div>
      ) : (
        <SettingsList>
          {visible?.map((group) => (
            <SettingsRow
              key={group.id}
              leading={<GroupAvatar group={group} />}
              title={<span dir="auto">{group.name ?? "未命名群"}</span>}
              detail={
                <span role={changing === group.id ? "status" : undefined}>
                  {changing === group.id
                    ? "正在更新…"
                    : group.enabled
                      ? "回应消息"
                      : "不回应消息"}
                </span>
              }
              trailing={
                <Toggle
                  checked={group.enabled}
                  disabled={busy || !available}
                  aria-describedby="group-participation-help"
                  aria-label={`${group.name ?? "未命名群"}：回应消息`}
                  onCheckedChange={(enabled) => {
                    setLastGroup(group.id);
                    setChanging(group.id);
                    void act({
                      type: "updateGroupParticipation",
                      chatId: group.id,
                      enabled,
                    }).finally(() => setChanging(null));
                  }}
                />
              }
              feedback={
                shownProblem &&
                lastGroup === group.id && (
                  <p role="alert" className="text-sm leading-6 text-error">
                    {shownProblem.message}
                  </p>
                )
              }
            />
          ))}
          {visible?.length === 0 && (
            <li role="status" className="py-6 text-center text-sm text-muted">
              没有匹配的群聊。
            </li>
          )}
        </SettingsList>
      )}
    </section>
  );
}
