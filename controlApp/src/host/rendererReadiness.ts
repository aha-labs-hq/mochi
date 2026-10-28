type StartupFailure =
  | "first-frame-timeout"
  | "script-error"
  | "promise-error"
  | "render-failed";

/** A hidden native window needs both a subscriber and a painted surface.
 * Silence is a bounded startup failure, never an indefinitely invisible App. */
export class RendererReadiness {
  private subscriber = false;
  private painted = false;
  private settled = false;
  private readonly deadline: ReturnType<typeof setTimeout>;

  constructor(
    private readonly show: () => void,
    private readonly failed: (reason: StartupFailure) => void,
    timeoutMs = 15_000,
  ) {
    this.deadline = setTimeout(
      () => this.fail("first-frame-timeout"),
      timeoutMs,
    );
  }

  subscribed(): void {
    this.subscriber = true;
    this.advance();
  }

  firstFrame(): void {
    this.painted = true;
    this.advance();
  }

  fail(reason: StartupFailure): void {
    if (this.settled) return;
    this.close();
    this.failed(reason);
  }

  close(): void {
    this.settled = true;
    clearTimeout(this.deadline);
  }

  private advance(): void {
    if (this.settled || !this.subscriber || !this.painted) return;
    this.close();
    this.show();
  }
}
