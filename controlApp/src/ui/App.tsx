import { animate, MotionConfig, motion } from "motion/react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import type { MotionCatalog } from "../motion/catalog.ts";
import { entrancePose } from "../motion/entrance.ts";
import type { FramePose } from "../motion/timeline.ts";
import { isByokFailureCode, PRODUCT_PROBLEM_CODES } from "../shared/bridge.ts";
import type { ExperienceIntent } from "../shared/experience.ts";
import type { ExperiencePreviewCommand } from "../shared/experiencePreview.ts";
import type {
  DesktopAction,
  DesktopSnapshot,
  SettingsIntent,
} from "../shared/model.ts";
import {
  type DesktopProblem,
  problem,
  reconcileActionProblem,
} from "../shared/problem.ts";
import { BotHome } from "./BotHome.tsx";
import { Character } from "./Character.tsx";
import type { Connection } from "./connection.ts";
import { Encounter } from "./Encounter.tsx";
import { ExperiencePreviewBar } from "./ExperiencePreviewBar.tsx";
import { experienceSample } from "./experiencePreview.ts";
import { FeltSurface } from "./FeltSurface.tsx";
import { Introduction } from "./Introduction.tsx";
import { PresentationViewport } from "./PresentationViewport.tsx";
import { SetupJourney } from "./Setup.tsx";
import { createDesktopStore, observeDesktop } from "./store.ts";
import { cn } from "./styles.ts";

export function App({
  connection,
  catalog,
}: {
  connection: Connection;
  catalog: MotionCatalog;
}) {
  const [store] = useState(createDesktopStore);
  const stage = useRef<HTMLElement>(null);
  const introductionHeight = useRef<number | null>(null);
  const setupHeight = useRef<number | null>(null);
  const setupResize = useRef<ReturnType<typeof animate> | null>(null);
  const attachStage = useCallback((node: HTMLElement | null) => {
    stage.current = node;
    if (node && introductionHeight.current !== null)
      node.style.setProperty(
        "--intro-height",
        `${introductionHeight.current}px`,
      );
    if (node && setupHeight.current !== null)
      node.style.setProperty("--setup-height", `${setupHeight.current}px`);
  }, []);
  const resizeIntroduction = useCallback((height: number | null) => {
    introductionHeight.current = height;
    if (height === null) stage.current?.style.removeProperty("--intro-height");
    else stage.current?.style.setProperty("--intro-height", `${height}px`);
  }, []);
  const resizeSetup = useCallback((height: number) => {
    setupResize.current?.stop();
    const update = (value: number) => {
      setupHeight.current = value;
      stage.current?.style.setProperty("--setup-height", `${value}px`);
    };
    if (
      setupHeight.current === null ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      update(height);
    else
      setupResize.current = animate(setupHeight.current, height, {
        duration: 0.32,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: update,
      });
  }, []);
  useEffect(() => () => setupResize.current?.stop(), []);
  const {
    snapshot: liveSnapshot,
    preview,
    connectionProblem,
    actionProblem,
    surface,
    handoff,
    receivedFrame,
    experiencePreview,
  } = useStore(store);
  const snapshot = useMemo(
    () =>
      experiencePreview
        ? experienceSample(experiencePreview.scene)
        : liveSnapshot,
    [experiencePreview, liveSnapshot],
  );
  const navigatePreview = useCallback(
    (command: ExperiencePreviewCommand) => {
      void connection
        .previewExperience(command)
        .catch(() =>
          store.setState({ connectionProblem: problem("control_unavailable") }),
        );
    },
    [connection, store],
  );
  const openSettings = (sheet: SettingsIntent, trigger: HTMLElement) => {
    if (experiencePreview) {
      navigatePreview(
        sheet === "groups"
          ? "feishu"
          : sheet === "projects"
            ? "projects"
            : "signIn",
      );
      return;
    }
    // Retain the shortcut focus when the independent Settings window opens.
    trigger.focus({ preventScroll: true });
    void connection
      .showSettings(sheet)
      .catch(() =>
        store.setState({ connectionProblem: problem("control_unavailable") }),
      );
  };
  const setActionProblem = useCallback(
    (actionProblem: DesktopProblem | null) =>
      store.setState({
        actionProblem: reconcileActionProblem(
          actionProblem,
          store.getState().snapshot,
        ),
      }),
    [store],
  );
  useEffect(() => observeDesktop(store, connection), [store, connection]);
  const perform = useCallback(
    async (action: DesktopAction) => {
      if (experiencePreview) {
        // Demo controls only move between labelled scenes. No OAuth, provider
        // refresh, installation, session initialization or external navigation.
        try {
          await connection.previewExperience(
            action.type === "cancelLogin" ||
              action.type === "cancelGitHubLogin" ||
              action.type === "cancelFeishuConnection"
              ? "previous"
              : "next",
          );
        } catch {
          store.setState({ connectionProblem: problem("control_unavailable") });
        }
        return false;
      }
      setActionProblem(null);
      try {
        const result = await connection.perform(action, snapshot.selectedBotId);
        if (!result.ok) setActionProblem(result.problem);
        return result.ok;
      } catch {
        setActionProblem(problem("control_unavailable"));
        return false;
      }
    },
    [
      connection,
      setActionProblem,
      experiencePreview,
      store,
      snapshot.selectedBotId,
    ],
  );
  const act = useCallback(
    async (action: DesktopAction) => {
      await perform(action);
    },
    [perform],
  );
  const character = preview
    ? catalog.character(preview.character)
    : catalog.character(
        snapshot.bots.find((bot) => bot.botId === snapshot.selectedBotId)
          ?.characterId ?? catalog.defaultCharacter.id,
      );
  const rootAsset = catalog.asset(character, character.rootAsset);
  const selectedPreview = preview
    ? character.previews.find((item) => item.id === preview.preview)
    : null;
  const previewStatic =
    selectedPreview?.type === "state" &&
    character.states.find((state) => state.id === selectedPreview.target)
      ?.motion.type === "static";
  const shownProblem = experiencePreview
    ? connectionProblem
    : (actionProblem ??
      connectionProblem ??
      snapshot.problem ??
      reconnectableBotProblem(snapshot));
  const encounter = surface === "encounter" && !preview;
  const introduction = surface === "intro" && !preview;
  const setup = surface === "setup" && !preview;
  const present = useCallback(
    (intent: ExperienceIntent) => {
      void connection
        .present(intent)
        .catch(() =>
          store.setState({ connectionProblem: problem("control_unavailable") }),
        );
    },
    [connection, store],
  );
  const arrival = useRef({ nonce: "", complete: false });
  const entranceNonce = experiencePreview?.nonce ?? "first-meeting";
  const begin = useCallback(() => {
    arrival.current.complete = true;
    present("beginSetup");
  }, [present]);
  const entrance = character.entrance;
  useLayoutEffect(() => {
    arrival.current = { nonce: entranceNonce, complete: false };
    const node = stage.current;
    if (!node) return;
    node.style.setProperty("--arrival-travel", encounter ? "0" : "1");
    node.style.setProperty("--arrival-rise", encounter ? "0" : "1");
    node.style.setProperty("--arrival-below", encounter ? "1" : "0");
    node.style.setProperty("--frame-reveal", encounter ? "0" : "1");
  }, [encounter, entranceNonce]);
  const paintedEntrance = useCallback(
    (pose: FramePose, reduced: boolean) => {
      if (!encounter || !entrance || !stage.current) return;
      const last = catalog.timing(entrance.sequence).frameCount - 1;
      const position =
        pose.type === "sequence" ? pose.position : pose.end ? last : 0;
      const placement = entrancePose(reduced ? last : position, entrance);
      stage.current.style.setProperty(
        "--arrival-travel",
        String(placement.travel),
      );
      stage.current.style.setProperty("--arrival-rise", String(placement.rise));
      stage.current.style.setProperty(
        "--arrival-below",
        String(placement.belowEdge),
      );
      stage.current.style.setProperty(
        "--frame-reveal",
        String(placement.frameReveal),
      );
      if (
        position >= last &&
        arrival.current.nonce === entranceNonce &&
        !arrival.current.complete
      ) {
        arrival.current.complete = true;
        present("meet");
      }
    },
    [encounter, entrance, catalog, present, entranceNonce],
  );
  const recover = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (shownProblem && isByokFailureCode(shownProblem.code)) {
      void act({ type: "configureByok" });
      return;
    }
    if (shownProblem?.code === "model_policy_unavailable") {
      openSettings("model", event.currentTarget);
      return;
    }
    if (shownProblem?.code === "setup_failed" && snapshot.selectedBotId) {
      void act({
        type: "setBotEnabled",
        botId: snapshot.selectedBotId,
        enabled: true,
      });
      return;
    }
    if (shownProblem?.code === "login_failed") {
      void act({ type: "login" });
      return;
    }
    switch (shownProblem?.recoveryAction) {
      case "prepareProduct":
        void act({ type: "prepare" });
        break;
      case "openApplicationsFolder":
        void act({ type: "openApplications" });
        break;
      case "openLoginItems":
        void act({ type: "openLoginItems" });
        break;
      case "restartService":
        void act({ type: "service", operation: "restart" });
        break;
      case "restartBot":
        void act({ type: "recoverBot" });
        break;
      case "reopenBrowser":
        void act({ type: "reopenLogin" });
        break;
      case "cancel":
        void act({ type: "cancelLogin" });
        break;
      case "exportDiagnostics":
      case "contactReleaseIssuer":
        openSettings("diagnostics", event.currentTarget);
        break;
      default:
        setActionProblem(null);
        void act({ type: "clearProblem" });
    }
  };
  // Do not mount a companion and morph it into the first authoritative surface.
  // The native readiness gate waits for this surface's actual character paint.
  if (!receivedFrame && !connectionProblem) return null;
  if (surface === "companion" || preview)
    return (
      <PresentationViewport
        handoff={handoff}
        fullscreen={false}
        connection={connection}
        failed={() =>
          store.setState({ connectionProblem: problem("control_unavailable") })
        }
      >
        <BotHome
          snapshot={snapshot}
          catalog={catalog}
          preview={preview}
          previewTitle={selectedPreview?.title}
          previewStatic={previewStatic}
          paused={handoff !== null}
          endPreview={
            preview || experiencePreview
              ? () => {
                  void connection.endPreview().catch(() =>
                    store.setState({
                      connectionProblem: problem("control_unavailable"),
                    }),
                  );
                }
              : undefined
          }
          previewFooter={
            experiencePreview && (
              <ExperiencePreviewBar
                preview={experiencePreview}
                navigate={navigatePreview}
                end={() => {
                  void connection.endPreview().catch(() =>
                    store.setState({
                      connectionProblem: problem("control_unavailable"),
                    }),
                  );
                }}
              />
            )
          }
          act={act}
          problem={shownProblem}
          recovery={
            shownProblem
              ? { label: recoveryLabel(shownProblem), run: recover }
              : null
          }
          openSettings={openSettings}
        />
      </PresentationViewport>
    );
  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ layout: { duration: 0.72, ease: [0.22, 1, 0.36, 1] } }}
    >
      <PresentationViewport
        handoff={handoff}
        fullscreen={encounter || introduction}
        connection={connection}
        failed={() =>
          store.setState({
            connectionProblem: problem("control_unavailable"),
          })
        }
      >
        <main
          ref={attachStage}
          data-testid="shell"
          data-setup={setup}
          data-surface={surface}
          data-experience-preview={experiencePreview?.scene}
          className={cn(
            "product-theme relative isolate flex size-full flex-col overflow-hidden [container-type:size] [--cat-offset:.28] @max-[740px]/presentation:[--cat-offset:.23]",
            encounter || introduction
              ? "bg-transparent [--felt-width:min(94cqw,544px)] [--felt-top:min(22cqh,200px)] [--felt-height:min(var(--intro-height,298px),calc(100cqh-var(--felt-top)-12px))] [--cat-size:min(20cqw,18cqh,128px)] [--frame-reveal:1] @max-[440px]/presentation:[--felt-top:18cqh] reduced-transparency:bg-surface"
              : "[--felt-width:min(calc(100cqw-24px),608px)] [--felt-top:clamp(96px,calc((100cqh-480px)/2),180px)] [--felt-height:min(var(--setup-height,480px),560px,calc(100cqh-var(--felt-top)-12px))] [--cat-size:min(20cqw,18cqh,128px)] [--frame-reveal:1] @max-[740px]/presentation:[--cat-size:94px]",
          )}
          style={
            {
              "--body-overhang":
                (rootAsset.geometry.canvasHeight -
                  rootAsset.geometry.bodyBottom) /
                rootAsset.geometry.canvasHeight,
            } as CSSProperties
          }
        >
          <FeltSurface />
          <motion.section
            layout={encounter || introduction ? false : "position"}
            layoutDependency={surface}
            initial={false}
            className={cn(
              "pointer-events-none z-2 min-h-0",
              encounter
                ? "absolute h-0 w-px left-[calc(78cqw*(1-var(--arrival-travel,0))+(50cqw+var(--felt-width)*var(--cat-offset))*var(--arrival-travel,0))] top-[calc(100cqh*(1-var(--arrival-rise,0))+var(--cat-size)*var(--arrival-below,1)+var(--felt-top)*var(--arrival-rise,0))]"
                : "absolute top-0 bottom-[calc(100%-var(--felt-top))] left-[calc(50%+var(--felt-width)*var(--cat-offset))] w-px",
            )}
            aria-label="角色"
          >
            <Character
              catalog={catalog}
              character={character}
              phase={introduction || encounter ? "checking" : "listening"}
              preview={null}
              paper
              event={
                encounter && entrance
                  ? {
                      sequence: entrance.sequence,
                      nonce: entranceNonce,
                      startFrame:
                        experiencePreview?.scene === "peek"
                          ? entrance.peek
                          : experiencePreview?.scene === "jump"
                            ? entrance.jump
                            : experiencePreview?.scene === "landing"
                              ? entrance.land
                              : 0,
                    }
                  : undefined
              }
              paused={handoff !== null}
              painted={paintedEntrance}
            />
          </motion.section>
          {encounter && (
            <Encounter skip={begin} available={entrance !== undefined} />
          )}
          {encounter || introduction ? (
            <Introduction
              key={`introduction:${experiencePreview?.nonce ?? "first-meeting"}`}
              begin={begin}
              resize={resizeIntroduction}
              modalOpen={false}
              moving={handoff !== null}
              arriving={encounter}
            />
          ) : setup ? (
            <SetupJourney
              key={`setup:${experiencePreview?.nonce ?? "first-meeting"}`}
              resize={resizeSetup}
              snapshot={snapshot}
              perform={perform}
              problem={shownProblem}
              recover={recover}
              recoveryLabel={shownProblem ? recoveryLabel(shownProblem) : null}
              openSettings={(section, event) =>
                openSettings(section, event.currentTarget)
              }
              finish={() => present("finishSetup")}
              close={() => connection.closeWindow()}
              preview={experiencePreview !== null}
            />
          ) : null}
          {experiencePreview && (
            <ExperiencePreviewBar
              preview={experiencePreview}
              navigate={navigatePreview}
              end={() => {
                void connection.endPreview().catch(() =>
                  store.setState({
                    connectionProblem: problem("control_unavailable"),
                  }),
                );
              }}
            />
          )}
        </main>
      </PresentationViewport>
    </MotionConfig>
  );
}

/**
 * The selected Bot's own failure when only reconnecting that Bot can fix it,
 * so the customer can act on it without restarting every Bot.
 */
function reconnectableBotProblem(
  snapshot: DesktopSnapshot,
): DesktopProblem | null {
  const code = snapshot.bots.find(
    (bot) => bot.botId === snapshot.selectedBotId,
  )?.problemCode;
  if (!code || !(PRODUCT_PROBLEM_CODES as readonly string[]).includes(code))
    return null;
  const value = problem(code as (typeof PRODUCT_PROBLEM_CODES)[number]);
  return value.recoveryAction === "restartBot" ? value : null;
}

function recoveryLabel(value: DesktopProblem): string {
  if (value.code === "model_policy_unavailable") return "选择模型";
  if (isByokFailureCode(value.code)) return "检查连接";
  if (value.code === "login_failed") return "重新登录";
  return {
    prepareProduct: "准备 Mochi",
    openApplicationsFolder: "打开“应用程序”",
    openLoginItems: "打开系统设置",
    restartService: "重新连接",
    restartBot: "重新连接",
    reopenBrowser: "打开浏览器",
    cancel: "取消登录",
    exportDiagnostics: "查看诊断",
    contactReleaseIssuer: "查看诊断",
    // Dismissing brings back the action the customer took, to repeat where it was.
    wait: "知道了",
    retry: "知道了",
  }[value.recoveryAction];
}
