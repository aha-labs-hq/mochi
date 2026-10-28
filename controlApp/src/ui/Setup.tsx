import { AnimatePresence } from "motion/react";
import { useCallback, useLayoutEffect, useRef } from "react";
import {
  githubAccountOf,
  githubProjectsOf,
  githubStatusOf,
} from "../shared/connectorView.ts";
import type {
  DesktopAction,
  DesktopSnapshot,
  SettingsIntent,
} from "../shared/model.ts";
import type { DesktopProblem } from "../shared/problem.ts";
import {
  chatServiceName,
  companionName,
  PHASE_WORDS,
  sharedMemoryNote,
  zh,
} from "../shared/vocabulary.ts";
import { Button, StatusMark } from "./Controls.tsx";
import {
  FeishuConnectionPanel,
  useFeishuApprovalWatch,
} from "./FeishuConnection.tsx";
import { Glyph } from "./Glyph.tsx";
import { GroupAvatar } from "./GroupAvatar.tsx";
import { JourneyAction } from "./JourneyAction.tsx";
import { JourneyScene } from "./JourneyScene.tsx";
import { ProjectsSettings } from "./ProjectsSettings.tsx";
import { setupPresentation } from "./setupPresentation.ts";
import { cn } from "./styles.ts";

/** First-run composition of the same connection components used in Settings. */
export function SetupJourney({
  snapshot: live,
  perform,
  problem,
  recover,
  recoveryLabel,
  openSettings,
  finish,
  close,
  preview = false,
  resize,
}: {
  snapshot: DesktopSnapshot;
  perform(action: DesktopAction): Promise<boolean>;
  problem: DesktopProblem | null;
  recover(event: React.MouseEvent<HTMLButtonElement>): void;
  recoveryLabel: string | null;
  openSettings(
    section: SettingsIntent,
    event: React.MouseEvent<HTMLButtonElement>,
  ): void;
  finish(): void;
  close(): void;
  preview?: boolean;
  resize(height: number): void;
}) {
  const act = useCallback(
    async (action: DesktopAction) => {
      await perform(action);
    },
    [perform],
  );
  // An administrator's approval is watched here, so the heading and the
  // connection form present the same held page while a check is in flight.
  const approval = useFeishuApprovalWatch(live, perform, !preview);
  const snapshot = approval.snapshot;
  const scene = setupPresentation(snapshot);
  const panel = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const busy = snapshot.busy !== null;
  const busyLabel =
    snapshot.busy === "prepare"
      ? "正在准备…"
      : snapshot.busy === "setBotEnabled"
        ? "正在启动…"
        : snapshot.busy === "login" || snapshot.busy === "reopenLogin"
          ? "正在打开授权页…"
          : "请稍候…";
  const groups = scene.id === "groups" || scene.id === "connecting";
  const section =
    scene.id === "projects"
      ? "projects"
      : scene.id === "feishu"
        ? "groups"
        : groups || scene.id === "ready" || scene.id === "initializing"
          ? "duty"
          : scene.id === "welcome" || scene.id === "location"
            ? null
            : "account";
  const selectedBot = snapshot.bots.find(
    (bot) => bot.botId === snapshot.selectedBotId,
  );
  const hasConnections =
    snapshot.account.status === "signedIn" ||
    snapshot.feishu.active !== null ||
    githubStatusOf(snapshot.connectorCatalog) === "connected";
  const name = companionName(snapshot);
  const service = chatServiceName(snapshot);
  const resumePreparation =
    problem?.code === "setup_failed" && snapshot.setup === "ready"
      ? scene.action
      : null;
  const enabled = snapshot.feishuGroups?.filter((group) => group.enabled) ?? [];
  useLayoutEffect(() => {
    const frame = panel.current!;
    const reading = frame.querySelector<HTMLElement>("[data-journey-scroll]")!;
    const measure = () => {
      // Keep the current paper height while the previous task fades out.
      if (
        content.current?.querySelector<HTMLElement>("[data-chapter]")?.dataset
          .chapter !== scene.id
      )
        return;
      const frameStyle = getComputedStyle(frame);
      const readingStyle = getComputedStyle(reading);
      const surrounding = [
        frame.querySelector("ol"),
        frame.querySelector(groups ? "footer" : "[data-journey-resume]"),
      ].reduce(
        (height, node) => height + (node?.getBoundingClientRect().height ?? 0),
        0,
      );
      resize(
        Math.min(
          560,
          Math.ceil(
            content.current!.getBoundingClientRect().height +
              surrounding +
              Number.parseFloat(frameStyle.paddingTop) +
              Number.parseFloat(frameStyle.paddingBottom) +
              Number.parseFloat(readingStyle.paddingTop) +
              Number.parseFloat(readingStyle.paddingBottom),
          ),
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content.current!);
    for (const node of frame.querySelectorAll(
      "ol, footer, [data-journey-resume]",
    ))
      observer.observe(node);
    return () => observer.disconnect();
  }, [resize, groups, scene.id]);
  return (
    <section
      ref={panel}
      data-testid="setup-journey"
      data-density={
        scene.id === "projects" &&
        githubStatusOf(snapshot.connectorCatalog) === "connected" &&
        githubProjectsOf(snapshot.connectorCatalog).length > 0 &&
        !problem
          ? "selection"
          : "reading"
      }
      className="setup-theme group/setup absolute top-(--felt-top) left-[calc(50%-var(--felt-width)/2)] z-3 flex h-(--felt-height) w-(--felt-width) min-h-0 flex-col px-8 pt-12 pb-4 @max-[440px]/presentation:px-5"
    >
      <div className="electrobun-webkit-app-region-drag absolute top-0 right-12 left-0 h-11 [-webkit-app-region:drag]" />
      <Button
        variant="icon"
        aria-label="关闭窗口"
        title="关闭窗口"
        className="absolute top-2 right-2 z-1 size-8 min-h-8"
        onClick={close}
      >
        <Glyph name="close" size={15} />
      </Button>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {snapshot.setup !== "install" && (
          <ol
            aria-label="准备进度"
            className="m-0 flex min-h-5 flex-none list-none items-center gap-5"
          >
            {(
              [
                ["account", "模型"],
                ["groups", "群聊"],
                ["projects", "GitHub"],
                ["duty", "开始值班"],
              ] as const
            ).map(([id, title]) => {
              const completed =
                id === "account"
                  ? snapshot.account.status === "signedIn"
                  : id === "groups"
                    ? snapshot.feishu.active?.state === "ready"
                    : id === "projects"
                      ? githubStatusOf(snapshot.connectorCatalog) ===
                          "connected" &&
                        githubProjectsOf(snapshot.connectorCatalog).some(
                          (project) => project.selected,
                        )
                      : // Duty has begun only once the 伙伴 left setup enabled.
                        selectedBot?.enabled === true &&
                        snapshot.setup === null;
              return (
                <li
                  key={id}
                  aria-current={section === id ? "step" : undefined}
                  className="flex items-center gap-1.5 text-xs text-muted aria-[current=step]:font-semibold aria-[current=step]:text-ink"
                  data-completed={completed === true}
                >
                  {completed && <Glyph name="check" size={12} />}
                  {!completed && (
                    <span aria-hidden className="size-3 shrink-0" />
                  )}
                  <span data-step-label>{title}</span>
                  <span className="sr-only">
                    {completed
                      ? "，已完成"
                      : section === id
                        ? "，当前步骤"
                        : "，待完成"}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div
          className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-1 pt-6 pb-2 [scrollbar-width:thin] group-data-[density=selection]/setup:pt-7 @max-[440px]/presentation:pt-3"
          data-journey-scroll
        >
          <div ref={content} className="shrink-0">
            <AnimatePresence mode="wait" initial={false}>
              <JourneyScene
                key={scene.id}
                id={scene.id}
                focusKey={
                  problem?.code ??
                  (scene.id === "feishu"
                    ? `feishu:${snapshot.feishu.candidate?.state ?? snapshot.feishu.active?.state ?? "disconnected"}`
                    : scene.id === "projects"
                      ? `projects:${githubStatusOf(snapshot.connectorCatalog)}`
                      : scene.id)
                }
              >
                {problem && (
                  <StatusMark tone="error" className="mb-2">
                    {PHASE_WORDS.attention.label}
                  </StatusMark>
                )}
                <h1
                  tabIndex={-1}
                  className="w-fit max-w-full text-hero leading-10 font-semibold tracking-[-.035em] outline-none [text-wrap:balance] @max-[440px]/presentation:text-title @max-[440px]/presentation:leading-8"
                >
                  {problem?.title ?? scene.title}
                </h1>
                <p
                  role={
                    problem
                      ? "alert"
                      : !scene.action &&
                          !groups &&
                          scene.id !== "projects" &&
                          scene.id !== "feishu"
                        ? "status"
                        : undefined
                  }
                  className={cn(
                    "mt-3 max-w-[38em] text-base leading-[1.75] group-data-[density=selection]/setup:mt-2 @max-[440px]/presentation:mt-2",
                    problem ? "text-ink" : "text-muted",
                  )}
                >
                  {problem?.message ?? scene.detail}
                </p>
                {!problem &&
                  !groups &&
                  scene.id !== "projects" &&
                  scene.id !== "feishu" && (
                    <p className="mt-3 max-w-[38em] text-sm leading-[1.8] text-muted">
                      {scene.note}
                    </p>
                  )}
                {!problem && scene.checklist && (
                  <ul
                    aria-label="开始前准备"
                    className="mt-4 grid list-none grid-cols-2 gap-x-6 gap-y-4 py-1 @max-[440px]/presentation:gap-x-4 @max-[440px]/presentation:gap-y-2 @max-[440px]/presentation:py-1"
                  >
                    {scene.checklist.map((item) => (
                      <li
                        key={item.title}
                        className="min-w-0 text-sm leading-5"
                      >
                        <span className="block font-medium text-ink">
                          {item.title}
                        </span>
                        <span className="block text-xs leading-5 text-muted">
                          {item.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-8 group-data-[density=selection]/setup:mt-5 @max-[440px]/presentation:mt-5">
                  {problem ? (
                    <JourneyAction
                      disabled={busy}
                      onClick={(event) =>
                        resumePreparation
                          ? void act(resumePreparation.value)
                          : recover(event)
                      }
                    >
                      {busy
                        ? busyLabel
                        : (resumePreparation?.label ?? recoveryLabel)}
                    </JourneyAction>
                  ) : scene.id === "model" ? (
                    <JourneyAction
                      disabled={busy}
                      onClick={(event) => openSettings("model", event)}
                    >
                      打开设置选择模型
                    </JourneyAction>
                  ) : scene.id === "feishu" ? (
                    <FeishuConnectionPanel
                      snapshot={snapshot}
                      perform={perform}
                      watch={approval}
                      heading={false}
                      preview={preview}
                    />
                  ) : scene.id === "projects" ? (
                    <ProjectsSettings
                      key={
                        githubAccountOf(snapshot.connectorCatalog)?.id ??
                        "signed-out"
                      }
                      snapshot={snapshot}
                      perform={perform}
                      shownProblem={null}
                      presentation="setup"
                    />
                  ) : groups ? (
                    <>
                      <div className="flex flex-col gap-3">
                        {enabled.length > 0 && (
                          <ul
                            aria-label="已开启回应的群"
                            className="flex max-h-28 list-none flex-wrap gap-2 overflow-y-auto"
                          >
                            {enabled.map((group) => (
                              <li key={group.id} className="min-w-0">
                                <Button
                                  variant="text"
                                  className="m-0 flex min-h-11 max-w-full items-center gap-2.5 px-0 text-left"
                                  disabled={busy}
                                  onClick={() =>
                                    void act({
                                      type: "openFeishuGroup",
                                      chatId: group.id,
                                    })
                                  }
                                  aria-label={zh`在${service}打开 ${group.name ?? "群聊"}`}
                                >
                                  <GroupAvatar group={group} small />
                                  <span className="text-sm [overflow-wrap:anywhere]">
                                    {group.name}
                                  </span>
                                  <Glyph name="external" size={14} />
                                </Button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {scene.action && (
                          <Button
                            variant="text"
                            className="m-0 min-h-11 self-start px-0 text-action"
                            disabled={busy}
                            onClick={() => {
                              if (scene.action) void act(scene.action.value);
                            }}
                          >
                            {busy ? busyLabel : scene.action.label}
                          </Button>
                        )}
                      </div>
                      <p className="mt-3 text-xs leading-relaxed text-muted">
                        {sharedMemoryNote(name)}
                        新加入的群默认开启回应，随时可以在设置里暂停某个群。
                      </p>
                      {enabled.length > 0 && (
                        <div className="mt-6">
                          <p className="mb-2 text-xs text-muted">
                            比如，从这个问题开始
                          </p>
                          <p className="select-text text-base leading-[1.8] text-ink [overflow-wrap:anywhere]">
                            <span className="whitespace-nowrap">
                              @{snapshot.feishu.active?.bot?.name}
                            </span>{" "}
                            {githubProjectsOf(snapshot.connectorCatalog).find(
                              (project) => project.selected,
                            )?.fullName ?? "我们的项目"}{" "}
                            最近有哪些更新已经上线？
                          </p>
                          <p className="mt-2 text-xs leading-relaxed text-muted">
                            {zh`在${service}输入 @ 并选中这个机器人，再发送问题。`}
                          </p>
                        </div>
                      )}
                    </>
                  ) : scene.action ? (
                    <JourneyAction
                      disabled={
                        busy ||
                        (snapshot.setup !== "install" && !snapshot.controlReady)
                      }
                      onClick={() => {
                        if (scene.action) void act(scene.action.value);
                      }}
                    >
                      {busy ? busyLabel : scene.action.label}
                    </JourneyAction>
                  ) : (
                    <Glyph
                      name="spinner"
                      size={22}
                      className="my-3 text-action"
                      spin
                    />
                  )}
                  {!problem && scene.id === "signIn" && (
                    <Button
                      variant="text"
                      className="mt-3 min-h-11 px-0"
                      disabled={busy || !snapshot.controlReady}
                      onClick={() => void act({ type: "configureModelApi" })}
                    >
                      添加模型 API
                    </Button>
                  )}
                  {snapshot.setup === "signingIn" && (
                    <Button
                      variant="text"
                      className="mt-0 min-h-11 px-0 text-muted"
                      disabled={busy}
                      onClick={() => void act({ type: "cancelLogin" })}
                    >
                      稍后再连接
                    </Button>
                  )}
                </div>
                {!problem && scene.id === "feishu" && (
                  <p className="mt-5 max-w-[38em] text-sm leading-[1.8] text-muted">
                    {scene.note}
                  </p>
                )}
              </JourneyScene>
            </AnimatePresence>
          </div>
        </div>
        {!groups && snapshot.setup !== "install" && hasConnections && (
          <p
            data-journey-resume
            className="shrink-0 pt-6 text-xs leading-relaxed text-muted @max-[440px]/presentation:pt-3"
          >
            已完成的连接会保留，可以随时回来继续。
          </p>
        )}
        {groups && (
          <footer className="flex min-h-14 flex-none items-center justify-between gap-6 pt-3 text-xs leading-relaxed text-muted">
            <Button
              variant="text"
              className="m-0 inline-flex h-11 min-h-11 items-center px-0 py-0 text-muted"
              onClick={(event) => openSettings("groups", event)}
            >
              管理群聊
            </Button>
            {scene.id === "groups" && (
              <JourneyAction
                className="min-h-11 w-auto gap-5 border-0 pt-0"
                onClick={finish}
              >
                完成设置
              </JourneyAction>
            )}
          </footer>
        )}
      </div>
    </section>
  );
}
