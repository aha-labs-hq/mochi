import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApplicationMenuItemConfig } from "electrobun/main/app-menu";
import * as ApplicationMenu from "electrobun/main/app-menu";
import { BrowserView } from "electrobun/main/browser-view";
import { BrowserWindow } from "electrobun/main/browser-window";
import events from "electrobun/main/events";
import * as Utils from "electrobun/main/utils";
import distribution from "../../../release/distribution.json";
import updateConfiguration from "../../../release/updates.json";
import { fileLogSink, log, setLogSink } from "../../../src/log.ts";
import { packageTrustFromEnvironment } from "../../build/packageTrust.ts";
import { MotionCatalog } from "../motion/catalog.ts";
import {
  parseExperienceIntent,
  parseSettingsIntent,
} from "../shared/experience.ts";
import {
  EXPERIENCE_SCENES,
  experienceSceneIds,
  parseExperiencePreviewCommand,
} from "../shared/experiencePreview.ts";
import type {
  DesktopRPC,
  PreviewRequest,
  SettingsIntent,
} from "../shared/model.ts";
import { projectFailure } from "../shared/problem.ts";
import { parseSettingsRoute } from "../shared/settings.ts";
import { DESKTOP_RPC_TIMEOUT_MILLISECONDS } from "../shared/timing.ts";
import { parseHandoffReceipt } from "../shared/windowHandoff.ts";
import { appKit } from "./appKit.ts";
import { environment, locationReady } from "./contract.ts";
import { DesktopController } from "./controller.ts";
import { prepareProduct } from "./installer.ts";
import { menuBarState } from "./menuBar.ts";
import { nativeActions } from "./native.ts";
import { DesktopPresentation } from "./presentation.ts";
import { run as runCommand } from "./process.ts";
import { productRequests } from "./productRequests.ts";
import { DesktopQuit } from "./quit.ts";
import { rendererURL, settingsRendererURL } from "./renderer.ts";
import { RendererReadiness } from "./rendererReadiness.ts";
import { SettingsWindow } from "./settingsWindow.ts";
import { DesktopUninstall } from "./uninstall.ts";
import { updateService } from "./updateService.ts";
import { DesktopUpdates } from "./updates.ts";
import { TransitionInterrupted } from "./windowHandoff.ts";

declare const MOCHI_DEVELOPMENT: boolean;
declare const MOCHI_PACKAGE_TRUST: string;

let fatalShown = false;
/** Ends this App only. The background service is not the App's to stop here:
 * Bots already on duty keep working, and the next launch reconnects. */
function fatal(error: unknown): void {
  if (fatalShown) return;
  fatalShown = true;
  const failure = projectFailure(error, "component_contract_unavailable");
  console.error(
    JSON.stringify({ event: "host.failed", problem: failure.code }),
  );
  void Utils.showMessageBox({
    type: "error",
    title: "Mochi 无法继续显示",
    message: `${failure.message}已在后台值班的伙伴不受影响。`,
    buttons: ["退出"],
  }).then(() => Utils.quit());
}
/** An interrupted transition has already returned to its source scene. */
function presentationFailed(error: unknown): void {
  if (error instanceof TransitionInterrupted)
    log.warn("window.transition-interrupted", {
      reason: error.reason,
      processId: process.pid,
    });
  else fatal(error);
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

try {
  const env = environment();
  const viewURL = rendererURL(
    MOCHI_DEVELOPMENT && env.manifest.serviceMode === "development",
    process.env.MOCHI_RENDERER_URL,
  );
  setLogSink(fileLogSink(env.companionLogPath, { runMarker: "host.starting" }));
  if (viewURL.startsWith("http:")) {
    // The dev launcher keeps this pipe open. Its crash or exit revokes the local
    // renderer capability too; a later process cannot reuse the port in this App.
    void Bun.stdin
      .stream()
      .getReader()
      .read()
      .then(() => Utils.quit());
  }
  log.info("host.starting", {
    processId: process.pid,
    version: env.manifest.productVersion,
    deployment: env.manifest.serviceMode,
  });
  const catalog = new MotionCatalog(
    JSON.parse(
      readFileSync(join(env.resources, "CharacterMotionManifest.json"), "utf8"),
    ),
  );
  const kit = appKit(env.resources);
  const controller = new DesktopController(
    env,
    nativeActions(env, kit),
    undefined,
    undefined,
    (target) =>
      prepareProduct(target, undefined, undefined, kit.authorizeSetup),
  );
  await controller.refresh();
  const title = controller.snapshot.development ? "Mochi Development" : "Mochi";
  let window: BrowserWindow | null = null;
  let windowReady: Promise<void> | null = null;
  let stagingWindow: BrowserWindow | null = null;
  const presentation = new DesktopPresentation(() => controller.snapshot, {
    hasMet: kit.hasMet(),
    hasFinishedSetup: kit.hasFinishedSetup(),
    rememberFinishedSetup: () => kit.rememberFinishedSetup(),
    rememberMeeting: () => kit.rememberMeeting(),
    window: {
      plan: async (surface) => {
        const targetWindow = window,
          ready = windowReady;
        if (!targetWindow?.ptr || !ready)
          throw new TransitionInterrupted("closed", "No presentation window");
        await ready;
        if (window !== targetWindow)
          throw new TransitionInterrupted(
            "closed",
            "Presentation window closed",
          );
        stagingWindow = targetWindow;
        const plan = await kit.planWindow(targetWindow.ptr, surface);
        log.info("window.transition", { surface, visible: plan.visible });
        return plan;
      },
      place: async (rect, surface) => {
        // A closed window needs no restoration and must never target its replacement.
        if (window !== stagingWindow || !stagingWindow?.ptr) return;
        await kit.placeWindow(stagingWindow.ptr, rect, surface);
        log.info("window.presented", { surface: surface ?? "stage" });
      },
    },
  });
  controller.subscribe(() => {
    void presentation.observe().catch(presentationFailed);
  });

  function showWindow(): BrowserWindow {
    if (window) {
      window.show();
      window.activate();
      return window;
    }
    const ready = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});
    const readiness = new RendererReadiness(
      () => {
        if (window !== created) return;
        if (!created.ptr) {
          fatal(new Error("Native window unavailable"));
          return;
        }
        void kit
          .presentWindow(created.ptr, presentation.surface)
          .then(() => {
            if (window !== created) return;
            created.show();
            created.activate();
            ready.resolve();
            log.info("renderer.ready", { processId: process.pid });
          })
          .catch((error) => {
            ready.reject(error);
            fatal(error);
          });
      },
      (reason) => {
        log.error("renderer.startup-failed", {
          reason,
          processId: process.pid,
        });
        ready.reject(new Error("Renderer startup failed"));
        fatal(new Error("Renderer startup failed"));
      },
    );
    const rpc = BrowserView.defineRPC<DesktopRPC>({
      maxRequestTime: DESKTOP_RPC_TIMEOUT_MILLISECONDS,
      handlers: {
        requests: {
          ready: async (): Promise<undefined> => {
            attachment.ready();
            readiness.subscribed();
            return undefined;
          },
          present: (input) => {
            const intent = parseExperienceIntent(input);
            dispatchPresentation(() => presentation.present(intent));
            return undefined;
          },
          showSettings: (input) => {
            showSettings(parseSettingsIntent(input));
            return undefined;
          },
          previewExperience: (input) => {
            const command = parseExperiencePreviewCommand(input);
            dispatchPresentation(() => presentation.previewExperience(command));
            return undefined;
          },
          presentationPainted: async (input) => {
            const receipt = parseHandoffReceipt(input);
            presentation.acknowledge(receipt);
            log.info("window.paint-confirmed", {
              ...receipt,
              processId: process.pid,
            });
            return undefined;
          },
          ...productRequests(controller, (operation) =>
            presentation.live(operation),
          ),
          endPreview: () => {
            setPreview(null);
            return undefined;
          },
        },
        messages: {
          // This message is bound to its own renderer. Closing does not mark
          // setup complete or change any Bot, account or service state.
          closeWindow: () => created.close(),
        },
      },
    });
    const attachment = presentation.attach((frame) => {
      if (frame.handoff)
        log.info("window.paint-requested", {
          id: frame.handoff.id,
          step: frame.handoff.step,
          processId: process.pid,
        });
      rpc.send.frame(frame);
    });
    const created = new BrowserWindow({
      title,
      hidden: true,
      activate: false,
      frame: { width: 520, height: 700 },
      titleBarStyle: "hiddenInset",
      transparent: true,
      renderer: "native",
      url: viewURL,
      rpc,
      preload: `window.addEventListener('error', (event) => window.__electrobunSendToHost?.({type:'renderer-health',phase:'script-error',line:event.lineno,column:event.colno})); window.addEventListener('securitypolicyviolation', (event) => window.__electrobunSendToHost?.({type:'renderer-health',phase:'content-policy',directive:event.effectiveDirective}));`,
      navigationRules: JSON.stringify(["^*", viewURL]),
      sandbox: false,
    });
    window = created;
    windowReady = ready.promise;
    if (!created.ptr) throw new Error("Native window unavailable");
    kit.configureWindow(created.ptr);
    // v2.0.1 implements this documented event but omits it from BrowserView.on's
    // overload. Keep the version-specific adapter here, not in generated SDK types.
    const onHostMessage = created.webview.on.bind(
      created.webview,
    ) as unknown as (
      name: "host-message",
      listener: (event: unknown) => void,
    ) => void;
    onHostMessage("host-message", (event) => {
      try {
        // v2.0.1 dispatches parsed JSON here although its .d.ts says string.
        const health = (event as { data: { detail: unknown } }).data.detail as {
          type?: unknown;
          phase?: unknown;
          line?: unknown;
          column?: unknown;
          directive?: unknown;
        };
        if (
          health.type === "renderer-health" &&
          typeof health.phase === "string" &&
          [
            "module-starting",
            "catalog-ready",
            "motion-ready",
            "surface-ready",
            "render-failed",
            "motion-failed",
            "script-error",
            "promise-error",
            "content-policy",
          ].includes(health.phase)
        ) {
          // The first visible frame contains the real character, not an empty
          // WebView. Resource failures still reveal the explicit error surface.
          if (
            health.phase === "surface-ready" ||
            health.phase === "motion-ready" ||
            health.phase === "motion-failed"
          )
            readiness.firstFrame();
          if (
            health.phase === "script-error" ||
            health.phase === "promise-error" ||
            health.phase === "render-failed"
          )
            readiness.fail(health.phase);
          log.info("renderer.health", {
            phase: health.phase,
            processId: process.pid,
            ...(Number.isInteger(health.line)
              ? { line: Number(health.line), column: Number(health.column) }
              : {}),
            ...([
              "script-src",
              "script-src-elem",
              "style-src",
              "style-src-elem",
              "connect-src",
              "img-src",
            ].includes(String(health.directive))
              ? { directive: String(health.directive) }
              : {}),
          });
        }
      } catch {
        log.warn("renderer.health-rejected");
      }
    });
    created.webview.on("dom-ready", () => {
      log.info("renderer.loaded", { processId: process.pid });
    });
    // Returning to Mochi is when its facts matter; the Bot rechecks quietly.
    created.on("focus", () => void controller.recheck());
    created.on("close", () => {
      attachment.close();
      readiness.close();
      ready.reject(
        new TransitionInterrupted("closed", "Presentation window closed"),
      );
      if (window === created) {
        window = null;
        windowReady = null;
      }
    });
    return created;
  }
  const settings = new SettingsWindow(
    controller,
    kit,
    settingsRendererURL(viewURL),
    () => {
      showWindow();
    },
    fatal,
  );
  function showSettings(sheet: SettingsIntent): void {
    void presentation
      .prepareSettings()
      .then(() => settings.show(sheet))
      .catch(presentationFailed);
  }
  let updatingQuit = false;
  const updateCache = join(
    env.home,
    "Library/Caches/app.mochi.companion/Updates",
  );
  const returnPath = join(updateCache, "return.json");
  const packageTrust = packageTrustFromEnvironment(
    typeof MOCHI_PACKAGE_TRUST === "string" ? MOCHI_PACKAGE_TRUST : undefined,
  );
  const operatingSystem = await runCommand([
    "/usr/bin/sw_vers",
    "-productVersion",
  ]);
  const updater = new DesktopUpdates({
    cache: updateCache,
    version: env.manifest.productVersion,
    macOS: operatingSystem.stdout.trim(),
    trust:
      env.manifest.serviceMode === "installed" &&
      locationReady(env) &&
      packageTrust?.mode === "developer-id"
        ? {
            origin: distribution.downloads.baseUrl,
            feedPath: updateConfiguration.feedPath,
            publicKey: updateConfiguration.publicKey,
            teamId: packageTrust.teamId,
          }
        : null,
    fetch,
    service: updateService,
    repair: async () => {
      const result = await controller.perform({ type: "prepare" });
      if (!result.ok) throw Error("update_recovery");
    },
    changed: (view) => controller.publishUpdate(view),
    close: async (automatic) => {
      if (
        controller.snapshot.busy ||
        !(automatic
          ? await settings.canUpdateSilently()
          : await settings.approveClose("update"))
      )
        return false;
      // A draft decision may outlive the bounded handoff lease. Keep the App
      // open if the helper has already cancelled or failed that attempt.
      if ((await updateService("status")).phase !== "closing") return false;
      await mkdir(updateCache, { recursive: true, mode: 0o700 });
      await writeFile(
        `${returnPath}.new`,
        JSON.stringify({
          settings: settings.isOpen ? settings.route : null,
          selectedBotId: controller.snapshot.selectedBotId,
          companion: window !== null,
        }),
        { mode: 0o600 },
      );
      await rename(`${returnPath}.new`, returnPath);
      // The update lease already owns shutdown. Ordinary quit would stop it
      // a second time and could report success before the privileged handoff.
      updatingQuit = true;
      controller.stop();
      updater.stop();
      Utils.quit();
      return true;
    },
  });
  controller.updates = updater;
  controller.uninstall = new DesktopUninstall({
    approveClose: () => settings.approveClose("uninstall"),
    choose: () => kit.chooseUninstall(),
    service: updateService,
    pauseUpdates: () => updater.stop(),
    resumeUpdates: () => {
      void updater.start();
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 500)),
    close: () => {
      updatingQuit = true;
      controller.stop();
      updater.stop();
      Utils.quit();
    },
  });
  if (env.manifest.serviceMode === "installed" && locationReady(env)) {
    void updateService("status")
      .then((state) => {
        if (
          state.mode === "uninstall" &&
          state.phase === "failed" &&
          state.error !== "cancelled"
        ) {
          controller.reportUninstallFailure();
          showSettings("about");
        }
      })
      .catch(() => {});
  }
  void updater.start();
  async function restoreAfterUpdate(): Promise<void> {
    if (env.manifest.serviceMode !== "installed" || !locationReady(env)) return;
    try {
      const value = JSON.parse(await readFile(returnPath, "utf8"));
      await rm(returnPath);
      if (value.companion === true) showWindow();
      if (value.settings) settings.restore(parseSettingsRoute(value.settings));
      if (typeof value.selectedBotId === "string") {
        const restoreBot = () => {
          if (!controller.snapshot.controlReady) return;
          unsubscribe();
          if (
            controller.snapshot.bots.some(
              (bot) => bot.botId === value.selectedBotId,
            )
          )
            void controller.perform({
              type: "selectBot",
              botId: value.selectedBotId,
            });
        };
        const unsubscribe = controller.subscribe(restoreBot);
        restoreBot();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        log.warn("update.return-state-unavailable");
    }
  }
  void restoreAfterUpdate();
  const quitting = new DesktopQuit({
    approve: async () => {
      await updater.cancel();
      return settings.approveClose("quit");
    },
    shutdown: () => controller.shutdown(),
    revealFailure: () => {
      showWindow();
    },
    quit: () => Utils.quit(),
  });
  events.on("before-quit", (event) => {
    // After a fatal display failure the App leaves without stopping the Bots.
    if (quitting.allowed || updatingQuit || fatalShown) return;
    (event as { response: { allow: boolean } }).response = { allow: false };
    void quitting.request().catch(fatal);
  });
  function setPreview(request: PreviewRequest): void {
    dispatchPresentation(() => presentation.setPreview(request));
  }
  /** RPC only accepts the intent. Completion is the atomic frame after all paint
   * receipts; never hold a native transport request open waiting on its renderer. */
  function dispatchPresentation(operation: () => Promise<void>): void {
    showWindow();
    void operation().catch(presentationFailed);
  }
  // The trusted, local application has no embedded-browser feature or remote content surface.
  BrowserView.on("created", (view) => view.remove());

  function handleMenuAction(action: string): void {
    if (action === "show") showWindow();
    else if (action === "check-update") {
      showSettings("about");
      void updater.check();
    } else if (action === "intro") {
      dispatchPresentation(() => presentation.present("replayIntro"));
    } else if (action === "quit") {
      Utils.quit();
    } else if (
      action === "account" ||
      action === "model" ||
      action === "groups" ||
      action === "settings" ||
      action === "about" ||
      action === "diagnostics" ||
      action === "help"
    )
      showSettings(action);
    else if (action === "start" || action === "stop") {
      const current = menuBarState(controller.snapshot);
      if (!current.serviceEnabled || current.serviceOperation !== action)
        return;
      void presentation.live(() =>
        controller.perform({
          type: "service",
          operation: action,
        }),
      );
    } else if (action === "preview:stop") setPreview(null);
    else if (action.startsWith("experience:")) {
      const command = parseExperiencePreviewCommand(
        action.slice("experience:".length),
      );
      dispatchPresentation(() => presentation.previewExperience(command));
    } else if (action.startsWith("preview:")) {
      const [, characterID, previewID] = action.split(":");
      const character = catalog.characters.find(
        (entry) => entry.id === characterID,
      );
      const selected = character?.previews.find(
        (entry) => entry.id === previewID,
      );
      if (character && selected)
        setPreview({
          character: character.id,
          preview: selected.id,
          nonce: crypto.randomUUID(),
        });
    }
  }
  const previewMenu: ApplicationMenuItemConfig[] = catalog.characters.map(
    (character) => ({
      label: character.displayName,
      submenu: [...new Set(character.previews.map((item) => item.group))].map(
        (group) => ({
          label: group,
          submenu: character.previews
            .filter((item) => item.group === group)
            .map((item) => ({
              label: item.title,
              action: `preview:${character.id}:${item.id}`,
            })),
        }),
      ),
    }),
  );
  ApplicationMenu.setApplicationMenu([
    {
      label: title,
      submenu: [
        { label: `关于 ${title}`, action: "about" },
        { label: "检查更新…", action: "check-update" },
        { type: "divider" },
        { label: "设置…", action: "settings", accelerator: "Command+," },
        { type: "divider" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "divider" },
        { label: `退出 ${title}`, action: "quit", accelerator: "Command+Q" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "divider" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { label: "显示 Mochi", action: "show", accelerator: "Command+0" },
        { label: "关闭窗口", role: "close", accelerator: "Command+W" },
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
    ...(controller.snapshot.development
      ? ([
          {
            label: "体验预览",
            submenu: [
              ...experienceSceneIds.map((scene) => ({
                label: EXPERIENCE_SCENES[scene].label,
                action: `experience:${scene}`,
              })),
              { type: "divider" },
              {
                label: "上一环节",
                action: "experience:previous",
                accelerator: "Command+Shift+[",
              },
              {
                label: "重播当前环节",
                action: "experience:replay",
                accelerator: "Command+Shift+R",
              },
              {
                label: "下一环节",
                action: "experience:next",
                accelerator: "Command+Shift+]",
              },
              { label: "结束预览", action: "preview:stop" },
            ],
          },
          {
            label: "角色预览",
            submenu: [
              ...previewMenu,
              { type: "divider" },
              {
                label: "回到实时状态",
                action: "preview:stop",
                accelerator: "Command+Shift+0",
              },
            ],
          },
        ] satisfies ApplicationMenuItemConfig[])
      : []),
    {
      label: "帮助",
      submenu: [
        { label: "Mochi 使用帮助", action: "help" },
        ...(controller.snapshot.locationReady
          ? [{ label: "再次认识麻薯…", action: "intro" }]
          : []),
        { label: "运行诊断…", action: "diagnostics" },
      ],
    },
  ]);
  ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
    const action = (event as { data?: { action?: unknown } }).data?.action;
    if (typeof action === "string") handleMenuAction(action);
  });
  const menuBar = await kit.createMenuBar(
    menuBarState(controller.snapshot),
    (action) => {
      log.info("menu.action", { action });
      handleMenuAction(action);
    },
  );
  controller.subscribe((snapshot) => menuBar.update(menuBarState(snapshot)));
  // Creation is not proof that macOS has displayed the status item.
  log.info("menu.created", { processId: process.pid });
  events.on("reopen", () => {
    showWindow();
  });
  showWindow();
  log.info("host.ready", { processId: process.pid });
  controller.start();
} catch (error) {
  fatal(error);
}
