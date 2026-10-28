import { fail } from "../shared/problem.ts";
import type { UpdateServiceState } from "./updateService.ts";

/** The native choice never crosses the renderer. Root owns draining and removal. */
export class DesktopUninstall {
  private cancelled = false;
  private admitted = false;
  constructor(
    private readonly d: {
      approveClose(): Promise<boolean>;
      choose(): Promise<"keepData" | "deleteAll" | null>;
      service(
        command: "status" | "cancel" | "uninstall",
        candidate?: string,
        policy?: "keepData" | "deleteAll",
      ): Promise<UpdateServiceState>;
      pauseUpdates(): void;
      resumeUpdates(): void;
      close(): void;
      wait(): Promise<void>;
    },
  ) {}

  async start(): Promise<void> {
    this.cancelled = false;
    if (!(await this.d.approveClose())) return;
    const policy = await this.d.choose();
    if (!policy || this.cancelled) return;
    this.d.pauseUpdates();
    let closing = false;
    try {
      let state = await this.d.service("uninstall", undefined, policy);
      if (state.phase === "failed" || state.mode !== "uninstall")
        fail("product_uninstall_failed");
      this.admitted = true;
      if (this.cancelled) await this.d.service("cancel");
      while (true) {
        if (state.mode !== "uninstall") fail("product_uninstall_failed");
        if (state.phase === "failed") {
          if (state.error === "cancelled") return;
          fail("product_uninstall_failed");
        }
        if (state.phase === "closing" && !this.cancelled) {
          closing = true;
          this.d.close();
          return;
        }
        if (
          !["preparing", "waiting", "closing", "cancelling"].includes(
            state.phase,
          )
        )
          fail("product_uninstall_failed");
        await this.d.wait();
        state = await this.d.service("status");
      }
    } catch {
      if (this.admitted) await this.d.service("cancel").catch(() => {});
      fail("product_uninstall_failed");
    } finally {
      this.admitted = false;
      if (!closing) this.d.resumeUpdates();
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.admitted) await this.d.service("cancel");
  }
}
