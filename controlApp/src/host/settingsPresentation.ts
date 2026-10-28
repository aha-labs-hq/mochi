import type { DesktopSnapshot, SettingsIntent } from "../shared/model.ts";
import {
  type SettingsFrame,
  type SettingsRoute,
  settingsDestination,
} from "../shared/settings.ts";

/** One Settings window owns its route and delivery generation; snapshots still
 * come from the one application controller. It never receives preview facts. */
export class SettingsPresentation {
  private renderer: {
    send(frame: SettingsFrame): void;
    ready: boolean;
  } | null = null;
  private route: SettingsRoute = { page: "instructions" };
  private pending: SettingsRoute | null = null;

  constructor(private readonly snapshot: () => DesktopSnapshot) {}

  get currentRoute(): SettingsRoute {
    return this.route;
  }

  open(sheet: SettingsIntent): void {
    this.route = settingsDestination(sheet) ?? this.route;
    this.pending = this.route;
    this.publish();
  }

  remember(route: SettingsRoute): void {
    this.route = route;
  }

  attach(send: (frame: SettingsFrame) => void) {
    if (this.renderer)
      throw new Error("A Settings renderer is already attached");
    const renderer = { send, ready: false };
    this.renderer = renderer;
    this.pending = this.route;
    return {
      ready: () => {
        if (this.renderer !== renderer) return;
        renderer.ready = true;
        this.publish();
      },
      close: () => {
        if (this.renderer === renderer) this.renderer = null;
      },
    };
  }

  publish(): void {
    if (!this.renderer?.ready) return;
    const navigation = this.pending;
    this.pending = null;
    this.renderer.send({
      snapshot: this.snapshot(),
      ...(navigation ? { navigation } : {}),
    });
  }
}
