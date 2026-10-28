import type { Result } from "../shared/model.ts";

/** One quit transaction for the menu, Cmd-Q and native termination. A cancelled
 * draft decision or an unproven shutdown keeps the App alive. */
export class DesktopQuit {
  private flight: Promise<void> | null = null;
  private complete = false;
  constructor(
    private readonly actions: {
      approve(): Promise<boolean>;
      shutdown(): Promise<Result<null>>;
      revealFailure(): void;
      quit(): void;
    },
  ) {}

  get allowed(): boolean {
    return this.complete;
  }

  request(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = (async () => {
      if (!(await this.actions.approve())) return;
      const result = await this.actions.shutdown();
      if (!result.ok) {
        this.actions.revealFailure();
        return;
      }
      this.complete = true;
      this.actions.quit();
    })().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }
}
