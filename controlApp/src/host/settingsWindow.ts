import { BrowserView } from "electrobun/main/browser-view";
import { BrowserWindow } from "electrobun/main/browser-window";
import * as Utils from "electrobun/main/utils";
import { log } from "../../../src/log.ts";
import type { SettingsIntent } from "../shared/model.ts";
import { problem } from "../shared/problem.ts";
import {
  parseSettingsCloseState,
  parseSettingsRoute,
  type SettingsRoute,
  type SettingsRPC,
} from "../shared/settings.ts";
import { DESKTOP_RPC_TIMEOUT_MILLISECONDS } from "../shared/timing.ts";
import type { AppKit } from "./appKit.ts";
import type { DesktopController } from "./controller.ts";
import { productRequests } from "./productRequests.ts";
import { RendererReadiness } from "./rendererReadiness.ts";
import { SettingsPresentation } from "./settingsPresentation.ts";

type CloseSource = "window" | "quit" | "update" | "uninstall";
/** A busy close names what waits, not a guess at the operation: loading a model
 * list, the model API form or the diagnostics save panel is not "saving". */
const BUSY_CLOSE: Record<CloseSource, string> = {
  window: "当前操作结束后，再关闭设置。",
  quit: "当前操作结束后，再退出 Mochi。",
  update: "当前操作结束后，再开始更新。",
  uninstall: "当前操作结束后，再开始卸载。",
};

/** One native Settings slot. Closing it never stops the shared controller or
 * touches the companion slot; late callbacks retain the exact created window. */
export class SettingsWindow {
  private window: BrowserWindow | null = null;
  private closeFlight: Promise<boolean> | null = null;
  private readCloseState: (() => Promise<unknown>) | null = null;
  private subscribed = false;
  private visibleReady = false;
  private readonly presentation: SettingsPresentation;

  constructor(
    private readonly controller: DesktopController,
    private readonly kit: AppKit,
    private readonly url: string,
    private readonly showCompanion: () => void,
    private readonly failed: (error: unknown) => void,
  ) {
    this.presentation = new SettingsPresentation(() => controller.snapshot);
    controller.subscribe(() => this.presentation.publish());
  }

  get route(): SettingsRoute {
    return this.presentation.currentRoute;
  }
  restore(route: SettingsRoute): void {
    this.presentation.remember(route);
    this.show("settings");
  }
  async canUpdateSilently(): Promise<boolean> {
    if (this.controller.snapshot.busy) return false;
    if (!this.window) return true;
    if (!this.subscribed || !this.readCloseState) return false;
    try {
      const state = parseSettingsCloseState(await this.readCloseState());
      return !state.dirty && !state.busy;
    } catch {
      return false;
    }
  }
  get isOpen(): boolean {
    return this.window !== null;
  }

  show(sheet: SettingsIntent): void {
    this.presentation.open(sheet);
    if (this.window) {
      if (this.visibleReady) {
        this.window.show();
        this.window.activate();
      }
      return;
    }
    const readiness = new RendererReadiness(
      () => {
        if (this.window !== created) return;
        this.visibleReady = true;
        created.show();
        created.activate();
        log.info("settings.renderer-ready", {
          processId: process.pid,
          windowId: created.id,
        });
      },
      (reason) => {
        log.error("settings.startup-failed", {
          reason,
          processId: process.pid,
        });
        this.failed(new Error("Settings renderer startup failed"));
      },
    );
    const rpc = BrowserView.defineRPC<SettingsRPC>({
      maxRequestTime: DESKTOP_RPC_TIMEOUT_MILLISECONDS,
      handlers: {
        requests: {
          ...productRequests(this.controller, (operation) => operation()),
          ready: async () => {
            if (this.window !== created) return undefined;
            this.subscribed = true;
            attachment.ready();
            readiness.subscribed();
            return undefined;
          },
          rendered: async () => {
            if (this.window === created) readiness.firstFrame();
            return undefined;
          },
          rememberRoute: async (input) => {
            if (this.window === created)
              this.presentation.remember(parseSettingsRoute(input));
            return undefined;
          },
          showCompanion: async () => {
            this.showCompanion();
            return undefined;
          },
        },
        messages: {},
      },
    });
    const attachment = this.presentation.attach((frame) =>
      rpc.send.frame(frame),
    );
    const created = new BrowserWindow({
      title: "Mochi 设置",
      hidden: true,
      activate: false,
      frame: { width: 1040, height: 716 },
      titleBarStyle: "hiddenInset",
      transparent: true,
      renderer: "native",
      url: this.url,
      rpc,
      navigationRules: JSON.stringify(["^*", this.url]),
      sandbox: false,
    });
    this.window = created;
    this.readCloseState = () =>
      rpc.request.closeState(undefined, { maxRequestTime: 5_000 });
    if (!created.ptr) throw new Error("Native Settings window unavailable");
    this.kit.configureSettingsWindow(created.ptr);
    created.on("will-close", (event) => {
      (event as { response: { allow: boolean } }).response = { allow: false };
      void this.approveClose().then((allowed) => {
        if (allowed && this.window === created) created.close();
      });
    });
    // Coming back from Feishu or GitHub lands here; the Bot rechecks quietly.
    created.on("focus", () => void this.controller.recheck());
    created.webview.on("dom-ready", () =>
      log.info("settings.renderer-loaded", {
        processId: process.pid,
        windowId: created.id,
      }),
    );
    created.on("close", () => {
      attachment.close();
      readiness.close();
      if (this.window !== created) return;
      this.window = null;
      this.readCloseState = null;
      this.subscribed = false;
      this.visibleReady = false;
      log.info("settings.closed", {
        processId: process.pid,
        windowId: created.id,
      });
    });
    log.info("settings.created", {
      processId: process.pid,
      windowId: created.id,
    });
  }

  /** Native close, Cmd-W and application quit ask the live renderer once. The
   * reply is fresh, so a queued last keystroke cannot lose to a stale dirty flag. */
  approveClose(source: CloseSource = "window"): Promise<boolean> {
    if (!this.window) return Promise.resolve(true);
    if (this.closeFlight) return this.closeFlight;
    const target = this.window;
    log.info("settings.close-requested", {
      source,
      processId: process.pid,
      windowId: target.id,
    });
    const read = this.readCloseState;
    const subscribed = this.subscribed;
    this.closeFlight = (async () => {
      if (!subscribed || !read) return true; // A hidden, unmounted window has no draft.
      try {
        const state = parseSettingsCloseState(await read());
        if (this.window !== target) return false;
        log.info("settings.close-state", {
          dirty: state.dirty,
          busy: state.busy,
          processId: process.pid,
          windowId: target.id,
        });
        if (
          state.busy ||
          (this.controller.snapshot.busy !== null &&
            !(
              source === "uninstall" &&
              this.controller.snapshot.busy === "uninstall"
            ))
        ) {
          target.show();
          await Utils.showMessageBox({
            type: "info",
            title: problem("action_in_progress").title,
            message: BUSY_CLOSE[source],
            buttons: ["继续等待"],
          });
          return false;
        }
        if (!state.dirty) return true;
        target.show();
        target.activate();
        const accepted = await this.kit.confirm(
          "还没保存这次修改",
          "放弃未保存的设置并关闭？已保存的选择不会改变。",
          "放弃修改",
        );
        log.info("settings.discard-decision", {
          accepted,
          processId: process.pid,
          windowId: target.id,
        });
        return accepted && this.window === target;
      } catch {
        log.warn("settings.close-state-unavailable", {
          processId: process.pid,
          windowId: target.id,
        });
        if (this.window === target) {
          target.show();
          await Utils.showMessageBox({
            type: "warning",
            title: "暂时无法确认设置状态",
            message: "窗口已保留，避免丢失还没保存的修改。",
            buttons: ["返回设置"],
          });
        }
        return false;
      }
    })().finally(() => {
      this.closeFlight = null;
    });
    return this.closeFlight;
  }
}
