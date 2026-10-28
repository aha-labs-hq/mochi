import { Menu } from "@base-ui/react/menu";
import type { DesktopBotView } from "../host/fleet.ts";
import type { MotionCatalog } from "../motion/catalog.ts";
import type { DesktopSnapshot } from "../shared/model.ts";
import {
  botDisplayLabel,
  botStatus,
  NOT_RUNNING,
  PHASE_WORDS,
  type StatusWord,
} from "../shared/vocabulary.ts";
import { StatusMark } from "./Controls.tsx";
import { Glyph } from "./Glyph.tsx";
import { cn } from "./styles.ts";

/** A portrait is the character's approved still, never another motion player. */
export function BotPortrait({
  bot,
  catalog,
  available,
  className,
}: {
  bot: DesktopBotView;
  catalog: MotionCatalog;
  available: boolean;
  className?: string;
}) {
  const character = catalog.character(bot.characterId);
  const pose = catalog.state(character, available ? bot.phase : "checking");
  const asset = catalog.asset(character, pose.asset);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-end justify-center overflow-hidden rounded-lg bg-surface",
        className,
      )}
    >
      <img
        src={`./assets/${asset.resource}.png`}
        alt=""
        className="size-full object-contain"
      />
    </span>
  );
}

/** The roster chooses a viewpoint. Only the selected Bot's status row owns duty. */
export function BotSwitcher({
  snapshot,
  catalog,
  bot,
  select,
}: {
  snapshot: DesktopSnapshot;
  catalog: MotionCatalog;
  bot: DesktopBotView;
  select(botId: string): void;
}) {
  const available = snapshot.loaded && snapshot.controlReady;
  const neighbour = snapshot.bots.find((entry) => entry.botId !== bot.botId)!;
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`切换伙伴，当前${botDisplayLabel(bot, snapshot.bots)}`}
        title="查看所有伙伴"
        disabled={snapshot.busy !== null}
        className="group -mr-2 flex h-8 shrink-0 items-center gap-2 rounded-full pr-2 pl-1 text-xs text-muted transition-colors hover:bg-ink/5 hover:text-ink data-popup-open:bg-ink/5 data-popup-open:text-ink disabled:opacity-40 motion-reduce:transition-none control-focus"
      >
        <span aria-hidden className="relative h-7 w-10 shrink-0">
          <BotPortrait
            bot={neighbour}
            catalog={catalog}
            available={available}
            className="absolute top-0 right-0 size-6 rotate-8 border border-card bg-control"
          />
          <BotPortrait
            bot={bot}
            catalog={catalog}
            available={available}
            className="absolute bottom-0 left-0 size-6 -rotate-8 border border-card shadow-control"
          />
        </span>
        <span className="whitespace-nowrap">
          伙伴{" "}
          <span className="ml-0.5 tabular-nums">{snapshot.bots.length}</span>
        </span>
        <Glyph name="chevronUp" size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="top"
          align="end"
          sideOffset={12}
          collisionPadding={16}
          className="z-50"
        >
          <Menu.Popup
            aria-label="切换伙伴"
            className="product-theme flex max-h-[min(380px,var(--available-height))] w-80 max-w-[calc(100vw-32px)] origin-bottom-right flex-col overflow-hidden rounded-2xl border border-hairline bg-card p-2 shadow-surface outline-none transition-[opacity,transform] duration-150 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:translate-y-2 data-ending-style:opacity-0 motion-reduce:transition-none"
          >
            <div
              aria-hidden
              className="flex shrink-0 items-center justify-between px-3 pt-2 pb-3 text-xs text-muted"
            >
              <span>你的伙伴</span>
              <span>{snapshot.bots.length} 位</span>
            </div>
            <Menu.RadioGroup
              className="min-h-0 overflow-y-auto overscroll-contain"
              value={bot.botId}
              onValueChange={select}
            >
              {snapshot.bots.map((entry) => (
                <Menu.RadioItem
                  key={entry.botId}
                  value={entry.botId}
                  label={botDisplayLabel(entry, snapshot.bots)}
                  closeOnClick
                  disabled={snapshot.busy !== null}
                  aria-label={`切换到${botDisplayLabel(entry, snapshot.bots)}`}
                  className="group flex min-h-18 cursor-default items-center gap-3 rounded-xl px-3 py-2 outline-none data-checked:bg-ink/4 data-highlighted:bg-ink/7 data-disabled:opacity-40"
                >
                  <BotPortrait
                    bot={entry}
                    catalog={catalog}
                    available={available}
                    className="size-12"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {botDisplayLabel(entry, snapshot.bots)}
                    </p>
                    <BotStatusLine
                      className="mt-1"
                      bot={entry}
                      snapshot={snapshot}
                    />
                  </div>
                  <Menu.RadioItemIndicator className="flex size-5 shrink-0 items-center justify-center rounded-full bg-ink text-card">
                    <Glyph name="check" size={12} />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A 伙伴's live status as the roster shows it; stale facts are never shown as current. */
export function rosterStatus(
  bot: DesktopBotView,
  snapshot: DesktopSnapshot,
): StatusWord {
  return !snapshot.loaded
    ? NOT_RUNNING
    : !snapshot.controlReady
      ? PHASE_WORDS.checking
      : botStatus(bot);
}

function BotStatusLine({
  bot,
  snapshot,
  className,
}: {
  bot: DesktopBotView;
  snapshot: DesktopSnapshot;
  className?: string;
}) {
  const status = rosterStatus(bot, snapshot);
  return (
    <StatusMark tone={status.tone} className={className}>
      <span className="text-muted">{status.label}</span>
    </StatusMark>
  );
}
