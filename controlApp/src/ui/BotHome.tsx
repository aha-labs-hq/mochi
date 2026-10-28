import { Popover } from "@base-ui/react/popover";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";
import type { MotionCatalog } from "../motion/catalog.ts";
import type {
  DesktopAction,
  DesktopSnapshot,
  PreviewRequest,
  SettingsIntent,
} from "../shared/model.ts";
import type { DesktopProblem } from "../shared/problem.ts";
import {
  botDisplayLabel,
  botNeedsAttention,
  botProblem,
  botStatus,
  MEMORY,
  NOT_RUNNING,
  PHASE_WORDS,
  START_APPLICATION,
} from "../shared/vocabulary.ts";
import { BotDutySwitch } from "./BotDutySwitch.tsx";
import { BotSwitcher } from "./BotSwitcher.tsx";
import { Character } from "./Character.tsx";
import { Button } from "./Controls.tsx";
import { Glyph } from "./Glyph.tsx";
import { GroupAvatar } from "./GroupAvatar.tsx";
import { reportRendererHealth } from "./health.ts";
import { buttonStyles, cn } from "./styles.ts";

/** Sill actions keep a 36-point hit area inside the 28-point status row. */
const sillAction = "mx-0 -my-1 min-h-9 p-0 text-xs";

/** One character rests on the window sill. Selecting a companion never changes duty. */
export function BotHome({
  snapshot,
  catalog,
  act,
  openSettings,
  problem,
  recovery,
  preview = null,
  previewTitle,
  previewStatic = false,
  previewFooter,
  paused = false,
  endPreview,
}: {
  snapshot: DesktopSnapshot;
  preview?: PreviewRequest;
  previewTitle?: string | undefined;
  previewStatic?: boolean;
  previewFooter?: ReactNode;
  paused?: boolean;
  endPreview?: (() => void) | undefined;
  catalog: MotionCatalog;
  act(action: DesktopAction): Promise<void>;
  openSettings(sheet: SettingsIntent, target: HTMLElement): void;
  problem: DesktopProblem | null;
  recovery: {
    label: string;
    run(event: React.MouseEvent<HTMLButtonElement>): void;
  } | null;
}) {
  const root = useRef<HTMLElement>(null);
  const bot = snapshot.bots.find(
    (entry) => entry.botId === snapshot.selectedBotId,
  );
  useLayoutEffect(() => {
    if (bot || !root.current?.getBoundingClientRect().width) return;
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) reportRendererHealth("surface-ready");
    });
    return () => {
      active = false;
    };
  }, [bot]);
  const busy = snapshot.busy !== null || !snapshot.controlReady;
  const character = catalog.character(
    preview?.character ?? bot?.characterId ?? catalog.defaultCharacter.id,
  );
  const geometry = catalog.asset(character, character.rootAsset).geometry;
  const phase = !snapshot.loaded
    ? "stopped"
    : !snapshot.controlReady
      ? "checking"
      : (bot?.phase ?? "checking");
  const starting =
    snapshot.setup === "initializing" || bot?.lifecycle === "starting";
  const needsAccount = snapshot.account.status !== "signedIn";
  const accountAction =
    snapshot.account.status === "unknown"
      ? "检查连接"
      : snapshot.account.status === "signingIn"
        ? "继续登录"
        : "连接模型";
  const needsFeishu =
    snapshot.feishu.active?.state !== "ready" ||
    snapshot.feishu.candidate !== null;
  // A 伙伴's own failure has no deployment-wide recovery; it still gets a reason.
  const issue =
    !problem && bot && snapshot.controlReady && botNeedsAttention(bot)
      ? botProblem(bot)
      : null;
  const title =
    problem?.title ??
    (!snapshot.loaded
      ? NOT_RUNNING.label
      : !snapshot.controlReady
        ? PHASE_WORDS.checking.label
        : !bot
          ? "从一位伙伴开始"
          : starting
            ? PHASE_WORDS.starting.label
            : botStatus(bot).label);
  const groups =
    snapshot.feishuGroups?.filter((group) => group.enabled) ?? null;
  // A missing live roster is not an unnamed default Bot. Keep recovery at the
  // application level until the host can identify the actual companion.
  if (!bot && !preview && !endPreview)
    return (
      <main
        ref={root}
        data-testid="host-availability"
        className="product-theme relative flex h-full flex-col bg-card px-8 pt-21 pb-8"
      >
        <div
          aria-hidden
          className="electrobun-webkit-app-region-drag absolute inset-x-0 top-0 h-11 [-webkit-app-region:drag]"
        />
        <p className="font-brand text-title font-[750] tracking-[-.4px]">
          Mochi
        </p>
        <section
          className="flex flex-1 flex-col justify-center gap-4"
          aria-live="polite"
          role={problem ? "alert" : undefined}
        >
          <h1 className="text-heading font-semibold">{title}</h1>
          <p className="text-sm leading-relaxed text-muted">
            {problem?.message ??
              (!snapshot.loaded
                ? "启动后会读取已保存的伙伴与设置。"
                : snapshot.controlReady
                  ? "完成首次设置，让第一位伙伴开始工作。"
                  : "正在读取伙伴与设置，确认后会自动显示。")}
          </p>
        </section>
        {problem && recovery ? (
          <Button disabled={snapshot.busy !== null} onClick={recovery.run}>
            {recovery.label}
          </Button>
        ) : !snapshot.loaded ? (
          <Button
            disabled={snapshot.busy !== null}
            onClick={() => void act({ type: "service", operation: "start" })}
          >
            {START_APPLICATION}
          </Button>
        ) : null}
      </main>
    );
  return (
    <main
      ref={root}
      data-testid="bot-home"
      data-preview={Boolean(endPreview)}
      className="product-theme relative isolate flex h-full min-h-0 flex-col overflow-hidden pt-21 [container-type:size] bg-transparent"
      style={
        {
          "--body-overhang":
            (geometry.canvasHeight - geometry.bodyBottom) /
            geometry.canvasHeight,
        } as CSSProperties
      }
    >
      <div
        aria-hidden
        className="electrobun-webkit-app-region-drag absolute inset-x-0 top-0 h-11 [-webkit-app-region:drag]"
      />
      <header className="absolute inset-x-8 top-11 z-10 flex items-center justify-between gap-3">
        <p className="whitespace-nowrap font-brand text-title font-[750] tracking-[-.4px] @max-[400px]/presentation:text-heading">
          Mochi
        </p>
        <Button
          variant="icon"
          className="-mr-2"
          aria-label="设置"
          title="设置这位伙伴"
          disabled={
            Boolean(endPreview) || !snapshot.loaded || snapshot.busy !== null
          }
          onClick={(event) => openSettings("instructions", event.currentTarget)}
        >
          <Glyph name="gear" size={20} />
        </Button>
      </header>
      <section
        className="pointer-events-none relative z-2 min-h-0 flex-1 [--cat-size:min(110cqw,82cqh,420px)]"
        aria-label="角色"
        data-bot-id={bot?.botId}
      >
        <Character
          key={bot?.botId ?? "first-companion"}
          catalog={catalog}
          character={character}
          phase={phase}
          preview={preview}
          paused={paused}
        />
      </section>
      <section
        data-testid="companion-sill"
        className="relative z-1 grid h-31 shrink-0 grid-cols-[minmax(0,1fr)] grid-rows-[32px_28px] gap-2 bg-card px-8 pt-8 pb-6"
        aria-live="polite"
      >
        <div className="flex h-8 items-center justify-between gap-5">
          <h1
            aria-label={
              previewTitle ??
              (bot ? botDisplayLabel(bot, snapshot.bots) : "Mochi")
            }
            className="min-w-0 flex-1 text-heading leading-8 font-semibold tracking-[-.025em]"
          >
            <span className="block truncate" title={bot?.label}>
              {previewTitle ??
                (bot ? botDisplayLabel(bot, snapshot.bots) : "Mochi")}
            </span>
          </h1>
          {bot && snapshot.bots.length > 1 && !endPreview && (
            <BotSwitcher
              snapshot={snapshot}
              catalog={catalog}
              bot={bot}
              select={(botId) => void act({ type: "selectBot", botId })}
            />
          )}
        </div>
        <div className="flex min-w-0 items-center justify-between gap-4">
          {preview ? (
            <p className="min-w-0 truncate text-xs text-muted">
              {previewStatic ? "形象预览" : "动效预览"} · 不改变实际运行状态
            </p>
          ) : (
            <div
              data-testid="companion-status"
              className="flex min-w-0 items-center gap-2 text-xs leading-snug text-muted"
              role={problem ? "alert" : undefined}
            >
              {bot && !endPreview && (
                <BotDutySwitch bot={bot} snapshot={snapshot} act={act} />
              )}
              {problem ? (
                <Popover.Root key={`${bot?.botId}:${problem.code}`}>
                  <Popover.Trigger
                    aria-label={`${title}：查看原因`}
                    className="flex min-w-0 items-center gap-1 rounded-sm text-left hover:text-ink control-focus"
                  >
                    <span className="truncate">{title}</span>
                    <Glyph name="info" size={14} />
                  </Popover.Trigger>
                  <ReasonPopup title={title} message={problem.message} />
                </Popover.Root>
              ) : (
                <p className="truncate" title={title}>
                  {title}
                </p>
              )}
            </div>
          )}
          <div className="flex shrink-0 items-center">
            {preview && endPreview ? (
              <Button
                variant="text"
                className={sillAction}
                onClick={endPreview}
              >
                结束预览
              </Button>
            ) : endPreview ? null : problem && recovery ? (
              <Button
                variant="text"
                className={cn(sillAction, "text-primary")}
                disabled={snapshot.busy !== null}
                onClick={recovery.run}
              >
                {recovery.label}
                <Glyph name="arrowRight" size={14} />
              </Button>
            ) : !snapshot.loaded ? (
              <Button
                variant="text"
                className={cn(sillAction, "text-primary")}
                disabled={snapshot.busy !== null}
                onClick={() =>
                  void act({ type: "service", operation: "start" })
                }
              >
                {START_APPLICATION} <Glyph name="arrowRight" size={14} />
              </Button>
            ) : !bot ? (
              <Button
                variant="text"
                className={cn(sillAction, "text-primary")}
                disabled={busy}
                onClick={(event) =>
                  openSettings("instructions", event.currentTarget)
                }
              >
                开始设置 <Glyph name="arrowRight" size={14} />
              </Button>
            ) : starting ? null : needsAccount || needsFeishu ? (
              <Button
                variant="text"
                className={cn(sillAction, "text-primary")}
                disabled={busy}
                onClick={(event) =>
                  openSettings(
                    needsAccount
                      ? snapshot.account.status === "unknown"
                        ? "diagnostics"
                        : "account"
                      : "groups",
                    event.currentTarget,
                  )
                }
              >
                {needsAccount
                  ? accountAction
                  : snapshot.feishu.active
                    ? "查看群聊连接"
                    : "连接群聊"}{" "}
                <Glyph name="arrowRight" size={14} />
              </Button>
            ) : snapshot.setup === "ready" ? (
              <Button
                variant="text"
                className={cn(sillAction, "text-primary")}
                disabled={busy}
                onClick={() =>
                  void act({
                    type: "setBotEnabled",
                    botId: bot.botId,
                    enabled: true,
                  })
                }
              >
                开始值班 <Glyph name="arrowRight" size={14} />
              </Button>
            ) : issue ? (
              <Popover.Root key={`${bot?.botId}:${issue.code}`}>
                <Popover.Trigger
                  className={cn(
                    buttonStyles({ variant: "text" }),
                    sillAction,
                    "text-primary",
                  )}
                >
                  查看原因 <Glyph name="chevronRight" size={14} />
                </Popover.Trigger>
                <ReasonPopup
                  title={issue.title}
                  message={issue.message}
                  align="end"
                  action={{
                    label: "打开运行诊断",
                    run: (target) => openSettings("diagnostics", target),
                  }}
                />
              </Popover.Root>
            ) : snapshot.canOrganize ? (
              <Button
                variant="text"
                className={cn(sillAction, "text-primary")}
                disabled={busy}
                onClick={() => void act({ type: "organize" })}
              >
                <Glyph name="sparkle" size={16} />
                {MEMORY.organize}
              </Button>
            ) : (
              <button
                type="button"
                aria-label={
                  groups === null
                    ? "所在群"
                    : groups.length === 0
                      ? "选择回应的群"
                      : `${groups.length} 个群`
                }
                className="-mr-2 flex h-8 min-w-0 items-center gap-2 rounded-full bg-ink/4 py-1 pr-2 pl-1 text-xs text-muted transition-colors hover:bg-ink/7 hover:text-ink disabled:opacity-40 motion-reduce:transition-none control-focus"
                disabled={busy}
                onClick={(event) => openSettings("groups", event.currentTarget)}
              >
                {groups?.length ? (
                  <span className="flex shrink-0 gap-1">
                    {groups.slice(0, 3).map((group) => (
                      <GroupAvatar key={group.id} group={group} small />
                    ))}
                  </span>
                ) : (
                  <Glyph name="people" size={18} />
                )}
                <span className="truncate">
                  {groups === null
                    ? "所在群"
                    : groups.length === 0
                      ? "选择回应的群"
                      : `${groups.length} 个群`}
                </span>
                <Glyph name="chevronRight" size={14} />
              </button>
            )}
          </div>
        </div>
      </section>
      {previewFooter}
    </main>
  );
}

/** One explanation surface for a failure, whichever control opened it. */
function ReasonPopup({
  title,
  message,
  align = "start",
  action,
}: {
  title: string;
  message: string;
  align?: "start" | "end";
  action?: { label: string; run(target: HTMLElement): void };
}) {
  return (
    <Popover.Portal>
      <Popover.Positioner
        side="top"
        align={align}
        sideOffset={12}
        collisionPadding={16}
        className="z-50"
      >
        <Popover.Popup className="product-theme w-72 max-w-[calc(100vw-32px)] rounded-xl border border-hairline bg-card p-4 shadow-surface outline-none">
          <Popover.Title className="text-sm font-semibold">
            {title}
          </Popover.Title>
          <Popover.Description className="mt-2 text-xs leading-relaxed text-muted">
            {message}
          </Popover.Description>
          {action && (
            <Button
              variant="text"
              className="mx-0 mt-2 -mb-1 min-h-9 p-0 text-xs text-primary"
              onClick={(event) => action.run(event.currentTarget)}
            >
              {action.label} <Glyph name="chevronRight" size={14} />
            </Button>
          )}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}
